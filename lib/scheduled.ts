import { and, eq, gt, inArray, isNotNull, like, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { jobs } from "../db/schema";
import { discoverNewBoards, discoveryConfigured, discoveryDueAt } from "./discovery";
import { sendFitAlerts } from "./alerts";
import { syncOpenJobData } from "./openjobdata";
import { syncJobsPipe } from "./jobspipe";
import { syncJobDataLake } from "./jobdatalake";
import { ensureDefaultSources, retryDeadLetter, scanBoards, validatePendingSources } from "./pipeline";
import { getState, setState } from "./state";
import { scorePendingJobs } from "./fit";

/**
 * What the Worker cron runs every 5 minutes (Workers Paid plan — a run may use up to 30 s of CPU):
 *   1. Google discovery — weekdays at 6:30, 11:30, 14:30 and 19:30 Central (lib/discovery.ts discoverySchedule).
 *      A run costs ~384 Serper credits; ~88 runs a month ≈ 34k against the owner's ~48k monthly budget, leaving room
 *      for the dashboard's "Google search" button.
 *   2. Validate pending boards (newly discovered ones first).
 *   2b. Re-probe up to 40 dead-letter boards whose weekly retry is due (lib/dead-letter.ts); ones that answer
 *       rejoin the scan rotation, 404s are removed after one failed re-check, other failures after eight weeks.
 *   3. Scan boards that are due: bumped/new boards first, then productive boards not read in the last
 *      14 minutes (400 per run — 1,200 boards per 15 minutes), then quiet boards older than a day.
 */
/** Let the cron run Google discovery on its own at the weekday slots in lib/discovery.ts (discoverySchedule). */
const AUTO_DISCOVERY = true;

export async function runScheduledMaintenance() {
  const db = getDb();
  await ensureDefaultSources(db);
  const lastDiscovery = await getState(db, "last_discovery_at");
  const discoveryDue = AUTO_DISCOVERY && discoveryConfigured() && discoveryDueAt(new Date(), lastDiscovery);
  const discovery = discoveryDue ? await discoverNewBoards() : null;
  // JobDataLake as a free board finder: once a day, queue readable boards its index knows and the catalog lacks.
  const jobdatalake = await syncJobDataLake().catch(error => ({ configured: true as const, skipped: "error" as const, error: error instanceof Error ? error.message : String(error) }));
  const validation = await validatePendingSources(60);
  // A dead-letter problem must never stop the scan.
  const deadLetter = await retryDeadLetter(40).catch(error => ({ probed: 0, recovered: 0, failedAgain: 0, removed: 0, remaining: -1, error: error instanceof Error ? error.message : String(error) }));
  const since = new Date(Date.now() - 14 * 60 * 1000).toISOString();
  // 400 boards ≈ 4 s CPU / 25 s wall on Workers Paid; measured under the 1,000-subrequest ceiling.
  const scan = await scanBoards({ limit: 400, since, mode: "scheduled", concurrency: 8 });
  // openjobdata.com daily delta (postings on ATSs we cannot read); hourly, never allowed to fail the run.
  const openjobdata = await syncOpenJobData().catch(error => ({ skipped: "error" as const, error: error instanceof Error ? error.message : String(error) }));
  // JobsPipe: one daily query for US data roles whose posting says the employer sponsors; must never fail the run.
  const jobspipe = await syncJobsPipe().catch(error => ({ configured: true as const, skipped: "error" as const, error: error instanceof Error ? error.message : String(error) }));
  // A job scored before its description was read is re-scored once the description is in (the board-payload backfill
  // lands a few per scan). Then fit-score whatever is new; a scoring problem must never fail the scan.
  await db.update(jobs).set({ fitScore: null, fitReason: null, fitScoredAt: null }).where(and(inArray(jobs.status, ["New", "Saved"]), isNotNull(jobs.fitScoredAt), isNotNull(jobs.jdFetchedAt), gt(jobs.jdFetchedAt, sql`${jobs.fitScoredAt}`)));
  const fit = await scorePendingJobs(80).catch(error => ({ configured: true as const, scored: 0, failed: 0, remaining: -1, error: error instanceof Error ? error.message : String(error) }));
  // Push strong new matches (75+) to the owner's phone; an alert problem must never fail the run.
  const alerts = await sendFitAlerts().catch(error => ({ configured: false as const, sent: 0, failed: 0, error: error instanceof Error ? error.message : String(error) }));
  // Unverified (Google-only) jobs are never re-checked, so drop the ones older than 48 hours.
  await db.delete(jobs).where(and(like(jobs.source, "%(Google)%"), lt(jobs.discoveredAt, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()), eq(jobs.status, "New")));
  // Rows that came from an aggregator for a board we do not read have no scan to close them; anything no source has
  // seen for three days is closed (boards are re-read at least daily, so live jobs never get here).
  await db.update(jobs).set({ status: "Closed" }).where(and(inArray(jobs.status, ["New", "Saved"]), lt(jobs.lastSeenAt, new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())));
  await setState(db, "last_scheduled_run_at", new Date().toISOString());
  return { discovery, jobdatalake, validation, deadLetter, scan, fit, alerts, openjobdata, jobspipe };
}
