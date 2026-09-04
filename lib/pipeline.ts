import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../db";
import { ingestionRuns, jobs, sourceBoards, systemState } from "../db/schema";
import { boardKeyPrefix, enabledAts, fetchBoardJobs, type CanonicalJob } from "./ats-connectors";
import { defaultSources } from "./default-sources";

type Db = ReturnType<typeof getDb>;
type SourceRow = typeof sourceBoards.$inferSelect;

const MAX_FAILURES_BEFORE_DISABLE = 3;
const BATCH_STATEMENTS = 20;

function now() { return new Date().toISOString(); }

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index]); }
  }));
  return results;
}

type Statement = BatchItem<"sqlite">;

// D1 runs a batch as one round trip, which keeps large scans inside the Worker request budget.
async function runBatch(db: Db, statements: Statement[]) {
  for (let index = 0; index < statements.length; index += BATCH_STATEMENTS) {
    const chunk = statements.slice(index, index + BATCH_STATEMENTS);
    await db.batch(chunk as [Statement, ...Statement[]]);
  }
}

export async function ensureDefaultSources(db: Db) {
  for (let index = 0; index < defaultSources.length; index += 7) {
    await db.insert(sourceBoards).values(defaultSources.slice(index, index + 7)).onConflictDoNothing();
  }
}

export async function setState(db: Db, key: string, value: string) {
  const at = now();
  await db.insert(systemState).values({ key, value, updatedAt: at }).onConflictDoUpdate({ target: systemState.key, set: { value, updatedAt: at } });
}

export async function getState(db: Db, key: string) {
  const rows = await db.select({ value: systemState.value }).from(systemState).where(eq(systemState.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

/** Check pending catalog boards: a board that answers becomes active, one that fails becomes invalid. */
export async function validatePendingSources(limit = 30, concurrency = 6) {
  const db = getDb();
  const originPriority = sql`CASE ${sourceBoards.origin} WHEN 'poc' THEN 0 WHEN 'uploaded-lists' THEN 1 WHEN 'spreadsheet-current' THEN 2 WHEN 'spreadsheet-trial' THEN 3 ELSE 4 END`;
  const pending = await db.select().from(sourceBoards)
    .where(and(eq(sourceBoards.status, "pending"), inArray(sourceBoards.ats, enabledAts)))
    .orderBy(asc(originPriority), asc(sourceBoards.id)).limit(Math.min(60, Math.max(1, limit)));
  let active = 0, invalid = 0;
  const updates = await mapWithConcurrency(pending, concurrency, async source => {
    const at = now();
    try {
      const found = await fetchBoardJobs(source);
      active++;
      return db.update(sourceBoards).set({ status: "active", active: true, lastValidatedAt: at, lastError: null, consecutiveFailures: 0, lastJobCount: found.length, updatedAt: at }).where(eq(sourceBoards.id, source.id));
    } catch (error) {
      invalid++;
      return db.update(sourceBoards).set({ status: "invalid", active: false, lastValidatedAt: at, lastError: error instanceof Error ? error.message : "Validation failed", consecutiveFailures: 1, updatedAt: at }).where(eq(sourceBoards.id, source.id));
    }
  });
  if (updates.length) await runBatch(db, updates);
  const remainingRows = await db.select({ count: sql<number>`count(*)` }).from(sourceBoards).where(and(eq(sourceBoards.status, "pending"), inArray(sourceBoards.ats, enabledAts)));
  return { checked: pending.length, active, invalid, remaining: Number(remainingRows[0]?.count ?? 0) };
}

async function upsertBoardJobs(db: Db, source: SourceRow, found: CanonicalJob[], scanStartedAt: string) {
  const at = now();
  const prefix = boardKeyPrefix(source);
  const keys = found.map(job => job.canonicalKey);
  // D1 allows at most 100 bound parameters per statement, so keys and rows are chunked accordingly.
  const existingKeys = new Set<string>();
  for (let index = 0; index < keys.length; index += 90) {
    const rows = await db.select({ canonicalKey: jobs.canonicalKey }).from(jobs).where(inArray(jobs.canonicalKey, keys.slice(index, index + 90)));
    for (const row of rows) existingKeys.add(row.canonicalKey);
  }
  const statements: Statement[] = [];
  for (let index = 0; index < found.length; index += 6) {
    const chunk = found.slice(index, index + 6);
    statements.push(db.insert(jobs).values(chunk).$dynamic().onConflictDoUpdate({
      target: jobs.canonicalKey,
      set: {
        title: sql`excluded.title`, company: sql`excluded.company`, location: sql`excluded.location`, workplace: sql`excluded.workplace`,
        sourceUrl: sql`excluded.source_url`, applyUrl: sql`excluded.apply_url`, postedAt: sql`excluded.posted_at`, lastSeenAt: sql`excluded.last_seen_at`,
        // A job we auto-closed earlier that is back on the board becomes New again; statuses you set stay.
        status: sql`CASE WHEN ${jobs.status} = 'Closed' THEN 'New' ELSE ${jobs.status} END`,
      },
    }));
  }
  // Jobs from this board that the board no longer lists (or that no longer match) are closed.
  statements.push(db.update(jobs).set({ status: "Closed" }).where(and(
    sql`${jobs.canonicalKey} >= ${prefix} AND ${jobs.canonicalKey} < ${prefix + "\uffff"}`,
    lt(jobs.lastSeenAt, scanStartedAt),
    inArray(jobs.status, ["New", "Saved"]),
  )));
  statements.push(db.update(sourceBoards).set({ lastScannedAt: at, lastJobCount: found.length, lastError: null, consecutiveFailures: 0, status: "active", active: true, updatedAt: at }).where(eq(sourceBoards.id, source.id)));
  await runBatch(db, statements);
  const inserted = found.filter(job => !existingKeys.has(job.canonicalKey)).length;
  return { inserted, updated: found.length - inserted };
}

/**
 * Scan the active boards that have not been scanned since `since` (oldest first).
 * Call repeatedly with the same `since` until `remaining` is 0 to cover every board.
 */
export async function scanBoards(options: { limit?: number; since?: string; concurrency?: number } = {}) {
  const db = getDb();
  const limit = Math.min(60, Math.max(1, options.limit ?? 25));
  const since = options.since ?? now();
  const scanStartedAt = now();
  await ensureDefaultSources(db);
  const notScannedSince = or(isNull(sourceBoards.lastScannedAt), lt(sourceBoards.lastScannedAt, since));
  const filter = and(eq(sourceBoards.active, true), inArray(sourceBoards.ats, enabledAts), notScannedSince);
  const boards = await db.select().from(sourceBoards).where(filter).orderBy(asc(sourceBoards.lastScannedAt), asc(sourceBoards.id)).limit(limit);
  const [run] = await db.insert(ingestionRuns).values({ status: "running" }).returning();
  let fetched = 0, inserted = 0, updated = 0, failed = 0;
  const failures: Statement[] = [];
  await mapWithConcurrency(boards, options.concurrency ?? 6, async source => {
    try {
      const found = await fetchBoardJobs(source);
      fetched += found.length;
      const result = await upsertBoardJobs(db, source, found, scanStartedAt);
      inserted += result.inserted; updated += result.updated;
    } catch (error) {
      failed++;
      const at = now(), count = source.consecutiveFailures + 1, disable = count >= MAX_FAILURES_BEFORE_DISABLE;
      failures.push(db.update(sourceBoards).set({ lastScannedAt: at, lastError: error instanceof Error ? error.message : "Scan failed", consecutiveFailures: count, status: disable ? "error" : "active", active: !disable, updatedAt: at }).where(eq(sourceBoards.id, source.id)));
    }
  });
  if (failures.length) await runBatch(db, failures);
  const remainingRows = await db.select({ count: sql<number>`count(*)` }).from(sourceBoards).where(filter);
  const remaining = Number(remainingRows[0]?.count ?? 0);
  const status = boards.length && failed === boards.length ? "failed" : failed ? "partial" : "succeeded";
  await db.update(ingestionRuns).set({ finishedAt: now(), status, fetched, inserted, updated, failed }).where(eq(ingestionRuns.id, run.id));
  if (remaining === 0) await setState(db, "last_full_scan_at", now());
  return { runId: run.id, status, scanned: boards.length, fetched, inserted, updated, failed, remaining, since };
}

/** What the scheduled Worker cron runs: a slice of validation plus a slice of the stalest boards. */
export async function runScheduledMaintenance() {
  const db = getDb();
  await ensureDefaultSources(db);
  const validation = await validatePendingSources(20);
  // Re-scan boards that were last scanned more than 6 hours ago, stalest first.
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const scan = await scanBoards({ limit: 40, since });
  await setState(db, "last_scheduled_run_at", now());
  return { validation, scan };
}
