import { getDb } from "../db";
import { discoverNewBoards, discoveryConfigured, discoveryIntervalHours } from "./discovery";
import { ensureDefaultSources, scanBoards, validatePendingSources } from "./pipeline";
import { getState, setState } from "./state";

/**
 * What the Worker cron runs every 15 minutes:
 *   1. Google discovery when it is due (default every 2 hours, DISCOVERY_INTERVAL_HOURS to change) — finds
 *      new company boards, bumps boards with fresh hits, and adds unverified jobs from unsupported ATSs.
 *   2. Validate pending boards (newly discovered ones first).
 *   3. Scan boards that are due: bumped/new boards first, then productive boards older than 2 hours,
 *      then quiet boards older than a day.
 */
export async function runScheduledMaintenance() {
  const db = getDb();
  await ensureDefaultSources(db);
  const lastDiscovery = await getState(db, "last_discovery_at");
  const intervalMs = discoveryIntervalHours() * 60 * 60 * 1000;
  const discoveryDue = discoveryConfigured() && (!lastDiscovery || Date.now() - new Date(lastDiscovery).getTime() > intervalMs - 5 * 60 * 1000);
  const discovery = discoveryDue ? await discoverNewBoards() : null;
  const validation = await validatePendingSources(discovery?.newSources ? 40 : 15);
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const scan = await scanBoards({ limit: 120, since, mode: "scheduled", concurrency: 8 });
  await setState(db, "last_scheduled_run_at", new Date().toISOString());
  return { discovery, validation, scan };
}
