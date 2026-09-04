import { and, eq, like, lt } from "drizzle-orm";
import { getDb } from "../db";
import { jobs } from "../db/schema";
import { discoverNewBoards, discoveryConfigured, discoveryIntervalHours } from "./discovery";
import { ensureDefaultSources, scanBoards, validatePendingSources } from "./pipeline";
import { getState, setState } from "./state";

/**
 * What the Worker cron runs every 5 minutes (Workers Paid plan — a run may use up to 30 s of CPU):
 *   1. Google discovery — only when AUTO_DISCOVERY is on. It is off: Google runs from the dashboard's
 *      "Google search" button instead, so Serper credits are spent only when you ask.
 *   2. Validate pending boards (newly discovered ones first).
 *   3. Scan boards that are due: bumped/new boards first, then productive boards not read in the last
 *      14 minutes (400 per run — 1,200 boards per 15 minutes), then quiet boards older than a day.
 */
/** Set to true to let the cron run Google discovery every DISCOVERY_INTERVAL_HOURS (default 3) on its own. */
const AUTO_DISCOVERY = false;

export async function runScheduledMaintenance() {
  const db = getDb();
  await ensureDefaultSources(db);
  const lastDiscovery = await getState(db, "last_discovery_at");
  const intervalMs = discoveryIntervalHours() * 60 * 60 * 1000;
  const discoveryDue = AUTO_DISCOVERY && discoveryConfigured() && (!lastDiscovery || Date.now() - new Date(lastDiscovery).getTime() > intervalMs - 5 * 60 * 1000);
  const discovery = discoveryDue ? await discoverNewBoards() : null;
  const validation = await validatePendingSources(60);
  const since = new Date(Date.now() - 14 * 60 * 1000).toISOString();
  // 400 boards ≈ 4 s CPU / 25 s wall on Workers Paid; measured under the 1,000-subrequest ceiling.
  const scan = await scanBoards({ limit: 400, since, mode: "scheduled", concurrency: 8 });
  // Unverified (Google-only) jobs are never re-checked, so drop the ones older than 48 hours.
  await db.delete(jobs).where(and(like(jobs.source, "%(Google)%"), lt(jobs.discoveredAt, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()), eq(jobs.status, "New")));
  await setState(db, "last_scheduled_run_at", new Date().toISOString());
  return { discovery, validation, scan };
}
