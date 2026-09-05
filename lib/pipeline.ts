import { and, asc, desc, eq, gt, inArray, isNull, like, lt, not, or, sql, isNotNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../db";
import { ingestionRuns, jobs, sourceBoards } from "../db/schema";
import { boardKeyPrefix, drainDiscoveredBoards, enabledAts, fetchBoardJobs, type CanonicalJob, type DiscoveredBoard } from "./ats-connectors";
import { defaultSources } from "./default-sources";
import { excludedBoardLikes } from "./exclusions";
import { summarizeJd } from "./jd";
import { deadLetterFields, failureKinds, recoveredFields, type FailureKind } from "./dead-letter";
import { getState, setState } from "./state";

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

// Boards matching lib/exclusions.ts are skipped by validation and scanning alike.
const notExcluded = and(...excludedBoardLikes.flatMap(pattern => [not(like(sourceBoards.slug, pattern)), not(like(sourceBoards.companyName, pattern))]));

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

/** Boards an aggregator connector uncovered (e.g. a Workable account behind a jobs.workable.com hit) join the catalog as pending. */
async function queueDiscoveredBoards(db: Db, boards: DiscoveredBoard[]) {
  const rows = boards.map(board => ({ ...board, status: "pending", active: false }));
  for (let index = 0; index < rows.length; index += 10) await db.insert(sourceBoards).values(rows.slice(index, index + 10)).onConflictDoNothing();
}

/** Check pending catalog boards: a board that answers becomes active, one that fails becomes invalid. */
export async function validatePendingSources(limit = 30, concurrency = 6) {
  const db = getDb();
  const originPriority = sql`CASE ${sourceBoards.origin} WHEN 'google-discovery' THEN 0 WHEN 'poc' THEN 1 WHEN 'uploaded-lists' THEN 2 WHEN 'spreadsheet-current' THEN 3 WHEN 'spreadsheet-trial' THEN 4 ELSE 5 END`;
  const pending = await db.select().from(sourceBoards)
    .where(and(eq(sourceBoards.status, "pending"), inArray(sourceBoards.ats, enabledAts), notExcluded))
    .orderBy(asc(originPriority), asc(sourceBoards.id)).limit(Math.min(60, Math.max(1, limit)));
  let active = 0, invalid = 0;
  // Statements are collected rather than returned: a drizzle query is a thenable, so returning one from an
  // async callback would execute it on the spot and hand runBatch already-run results instead of statements.
  const updates: Statement[] = [];
  await mapWithConcurrency(pending, concurrency, async source => {
    const at = now();
    try {
      const found = await fetchBoardJobs(source);
      active++;
      updates.push(db.update(sourceBoards).set({ status: "active", active: true, lastValidatedAt: at, lastError: null, consecutiveFailures: 0, lastJobCount: found.length, ...recoveredFields, updatedAt: at }).where(eq(sourceBoards.id, source.id)));
    } catch (error) {
      invalid++;
      const message = error instanceof Error ? error.message : "Validation failed";
      updates.push(db.update(sourceBoards).set({ status: "invalid", active: false, lastValidatedAt: at, lastError: message, consecutiveFailures: 1, ...deadLetterFields(message, 1), updatedAt: at }).where(eq(sourceBoards.id, source.id)));
    }
  });
  if (updates.length) await runBatch(db, updates);
  const remainingRows = await db.select({ count: sql<number>`count(*)` }).from(sourceBoards).where(and(eq(sourceBoards.status, "pending"), inArray(sourceBoards.ats, enabledAts), notExcluded));
  return { checked: pending.length, active, invalid, remaining: Number(remainingRows[0]?.count ?? 0) };
}

async function upsertBoardJobs(db: Db, source: SourceRow, found: CanonicalJob[], scanStartedAt: string) {
  const at = now();
  const prefix = boardKeyPrefix(source);
  const keys = found.map(job => job.canonicalKey);
  // D1 allows at most 100 bound parameters per statement, so keys and rows are chunked accordingly.
  const existingKeys = new Set<string>(), needsJd = new Set<string>();
  for (let index = 0; index < keys.length; index += 90) {
    const rows = await db.select({ canonicalKey: jobs.canonicalKey, jdFetchedAt: jobs.jdFetchedAt }).from(jobs).where(inArray(jobs.canonicalKey, keys.slice(index, index + 90)));
    for (const row of rows) { existingKeys.add(row.canonicalKey); if (!row.jdFetchedAt) needsJd.add(row.canonicalKey); }
  }
  // Description intelligence is extracted for jobs we have not seen before (regexes over a few KB each — cheap per job,
  // but a 400-board scan would burn CPU re-doing thousands of known ones). The raw text itself is never stored.
  // Known jobs that predate description extraction are backfilled a few per scan, so it spreads over the cycles.
  const extractedAt = now();
  let backfill = 15;
  const rows = found.map(({ jdText, ...job }) => {
    if (!jdText) return job;
    const isNew = !existingKeys.has(job.canonicalKey);
    if (!isNew && (!needsJd.has(job.canonicalKey) || backfill-- <= 0)) return job;
    const jd = summarizeJd(jdText.slice(0, 8000));
    return { ...job, jdSkills: jd.skills.join(", ") || null, jdYears: jd.years, jdFlags: jd.flags.join(",") || null, jdFetchedAt: extractedAt };
  });
  const statements: Statement[] = [];
  // D1 allows 100 bound variables per statement; a job row now carries ~20 columns, so insert 4 rows at a time.
  for (let index = 0; index < rows.length; index += 4) {
    const chunk = rows.slice(index, index + 4);
    statements.push(db.insert(jobs).values(chunk).$dynamic().onConflictDoUpdate({
      target: jobs.canonicalKey,
      set: {
        title: sql`excluded.title`, company: sql`excluded.company`, location: sql`excluded.location`, workplace: sql`excluded.workplace`,
        sourceUrl: sql`excluded.source_url`, applyUrl: sql`excluded.apply_url`, lastSeenAt: sql`excluded.last_seen_at`,
        // Greenhouse lists only expose updated_at, so an edit would make an old post look new; keep the earliest date we
        // have (the scorer replaces it with first_published on first sight). Other ATSs report a real posting date.
        postedAt: sql`CASE WHEN excluded.source = 'Greenhouse' AND ${jobs.postedAt} IS NOT NULL THEN MIN(${jobs.postedAt}, excluded.posted_at) ELSE excluded.posted_at END`,
        salary: sql`COALESCE(excluded.salary, ${jobs.salary})`,
        jdSkills: sql`COALESCE(excluded.jd_skills, ${jobs.jdSkills})`, jdYears: sql`COALESCE(excluded.jd_years, ${jobs.jdYears})`, jdFlags: sql`COALESCE(excluded.jd_flags, ${jobs.jdFlags})`, jdFetchedAt: sql`COALESCE(excluded.jd_fetched_at, ${jobs.jdFetchedAt})`,
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
  statements.push(db.update(sourceBoards).set({ lastScannedAt: at, lastJobCount: found.length, lastError: null, consecutiveFailures: 0, status: "active", active: true, ...recoveredFields, updatedAt: at }).where(eq(sourceBoards.id, source.id)));
  await runBatch(db, statements);
  const inserted = found.filter(job => !existingKeys.has(job.canonicalKey)).length;
  return { inserted, updated: found.length - inserted };
}

/**
 * Scan the active boards that have not been scanned since `since` (oldest first).
 * Call repeatedly with the same `since` until `remaining` is 0 to cover every board.
 */
export async function scanBoards(options: { limit?: number; since?: string; concurrency?: number; mode?: "full" | "scheduled" } = {}) {
  const db = getDb();
  // 400 boards ≈ 3 subrequests each (fetch + D1), comfortably under the 1,000-subrequest ceiling per invocation.
  const limit = Math.min(400, Math.max(1, options.limit ?? 25));
  const since = options.since ?? now();
  const scanStartedAt = now();
  await ensureDefaultSources(db);
  const productive = gt(sourceBoards.lastJobCount, 0);
  // Scheduled mode keeps the feed fresh cheaply: boards that have produced matching jobs are re-scanned
  // every couple of hours, boards that never matched anything only once a day.
  const due = options.mode === "scheduled"
    ? or(isNull(sourceBoards.lastScannedAt), and(productive, lt(sourceBoards.lastScannedAt, since)), lt(sourceBoards.lastScannedAt, new Date(new Date(since).getTime() - 24 * 60 * 60 * 1000).toISOString()))
    : or(isNull(sourceBoards.lastScannedAt), lt(sourceBoards.lastScannedAt, since));
  const filter = and(eq(sourceBoards.active, true), inArray(sourceBoards.ats, enabledAts), notExcluded, due);
  const boards = await db.select().from(sourceBoards).where(filter).orderBy(desc(productive), asc(sourceBoards.lastScannedAt), asc(sourceBoards.id)).limit(limit);
  const [run] = await db.insert(ingestionRuns).values({ status: "running" }).returning();
  let fetched = 0, inserted = 0, updated = 0, failed = 0;
  const failures: Statement[] = [];
  await mapWithConcurrency(boards, options.concurrency ?? 6, async source => {
    try {
      const found = await fetchBoardJobs(source);
      fetched += found.length;
      await queueDiscoveredBoards(db, drainDiscoveredBoards());
      const result = await upsertBoardJobs(db, source, found, scanStartedAt);
      inserted += result.inserted; updated += result.updated;
    } catch (error) {
      failed++;
      const at = now(), count = source.consecutiveFailures + 1, disable = count >= MAX_FAILURES_BEFORE_DISABLE;
      const message = error instanceof Error ? error.message : "Scan failed";
      // After MAX_FAILURES_BEFORE_DISABLE the board leaves the scan rotation and enters the dead-letter queue.
      failures.push(db.update(sourceBoards).set({ lastScannedAt: at, lastError: message, consecutiveFailures: count, status: disable ? "error" : "active", active: !disable, ...(disable ? deadLetterFields(message, 1) : {}), updatedAt: at }).where(eq(sourceBoards.id, source.id)));
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

/**
 * Re-probe dead-letter boards that are due (`next_retry_at` in the past). A board that answers is reactivated; one
 * that fails again waits for its next weekly slot, or is deleted once its schedule is exhausted (the owner does not
 * want dead boards kept). Rows already marked dead by validation (policy exclusions) are swept out here too.
 * `force` ignores `next_retry_at` (used for a full manual re-check).
 */
export async function retryDeadLetter(limit = 40, concurrency = 8, force = false) {
  const db = getDb();
  const at = now();
  const parked = and(inArray(sourceBoards.status, ["invalid", "error"]), isNull(sourceBoards.deadAt), inArray(sourceBoards.ats, enabledAts), notExcluded);
  const due = force ? parked : and(parked, or(isNull(sourceBoards.nextRetryAt), lt(sourceBoards.nextRetryAt, at)));
  const swept = await db.delete(sourceBoards).where(isNotNull(sourceBoards.deadAt)).returning({ id: sourceBoards.id });
  const boards = await db.select().from(sourceBoards).where(due).orderBy(asc(sourceBoards.nextRetryAt), asc(sourceBoards.id)).limit(Math.min(120, Math.max(1, limit)));
  let recovered = 0, failedAgain = 0, removed = swept.length;
  const updates: Statement[] = [];
  await mapWithConcurrency(boards, concurrency, async source => {
    const probedAt = now();
    try {
      const found = await fetchBoardJobs(source);
      recovered++;
      updates.push(db.update(sourceBoards).set({ status: "active", active: true, lastValidatedAt: probedAt, lastError: null, consecutiveFailures: 0, lastJobCount: found.length, lastScannedAt: null, ...recoveredFields, updatedAt: probedAt }).where(eq(sourceBoards.id, source.id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Retry failed";
      const fields = deadLetterFields(message, source.retryCount + 1);
      if (fields.deadAt) { removed++; updates.push(db.delete(sourceBoards).where(eq(sourceBoards.id, source.id))); }
      else { failedAgain++; updates.push(db.update(sourceBoards).set({ lastValidatedAt: probedAt, lastError: message, ...fields, updatedAt: probedAt }).where(eq(sourceBoards.id, source.id))); }
    }
  });
  if (updates.length) await runBatch(db, updates);
  if (recovered) {
    const previous = Number(await getState(db, "dlq_recovered_total")) || 0;
    await setState(db, "dlq_recovered_total", String(previous + recovered));
  }
  if (removed) {
    const previous = Number(await getState(db, "dlq_removed_total")) || 0;
    await setState(db, "dlq_removed_total", String(previous + removed));
  }
  if (boards.length) await setState(db, "dlq_last_retry_at", at);
  const remainingRows = await db.select({ count: sql<number>`count(*)` }).from(sourceBoards).where(due);
  return { probed: boards.length, recovered, failedAgain, removed, remaining: Number(remainingRows[0]?.count ?? 0) };
}


/** What sits in the dead-letter queue, by reason, plus what is due and what has been given up on. */
export async function deadLetterSummary() {
  const db = getDb();
  const at = now();
  const rows = await db.select({ kind: sourceBoards.failureKind, dead: sql<number>`CASE WHEN ${sourceBoards.deadAt} IS NULL THEN 0 ELSE 1 END`, count: sql<number>`count(*)` })
    .from(sourceBoards).where(inArray(sourceBoards.status, ["invalid", "error"])).groupBy(sourceBoards.failureKind, sql`CASE WHEN ${sourceBoards.deadAt} IS NULL THEN 0 ELSE 1 END`);
  const byKind: Record<string, { waiting: number; dead: number }> = {};
  for (const kind of failureKinds) byKind[kind] = { waiting: 0, dead: 0 };
  let waiting = 0, dead = 0;
  for (const row of rows) {
    const kind = (row.kind ?? "transient") as FailureKind;
    byKind[kind] ??= { waiting: 0, dead: 0 };
    if (Number(row.dead)) { byKind[kind].dead += Number(row.count); dead += Number(row.count); }
    else { byKind[kind].waiting += Number(row.count); waiting += Number(row.count); }
  }
  const dueRows = await db.select({ count: sql<number>`count(*)` }).from(sourceBoards)
    .where(and(inArray(sourceBoards.status, ["invalid", "error"]), isNull(sourceBoards.deadAt), or(isNull(sourceBoards.nextRetryAt), lt(sourceBoards.nextRetryAt, at))));
  const nextRows = await db.select({ next: sql<string | null>`min(${sourceBoards.nextRetryAt})` }).from(sourceBoards)
    .where(and(inArray(sourceBoards.status, ["invalid", "error"]), isNull(sourceBoards.deadAt), gt(sourceBoards.nextRetryAt, at)));
  const sample = await db.select({ id: sourceBoards.id, companyName: sourceBoards.companyName, ats: sourceBoards.ats, failureKind: sourceBoards.failureKind, lastError: sourceBoards.lastError, retryCount: sourceBoards.retryCount, nextRetryAt: sourceBoards.nextRetryAt, deadAt: sourceBoards.deadAt })
    .from(sourceBoards).where(and(inArray(sourceBoards.status, ["invalid", "error"]), isNull(sourceBoards.deadAt), not(eq(sourceBoards.failureKind, "gone")))).orderBy(desc(sourceBoards.updatedAt)).limit(25);
  return { waiting, dead, dueNow: Number(dueRows[0]?.count ?? 0), nextRetryAt: nextRows[0]?.next ?? null, byKind, lastRetryAt: await getState(db, "dlq_last_retry_at"), recoveredTotal: Number(await getState(db, "dlq_recovered_total")) || 0, removedTotal: Number(await getState(db, "dlq_removed_total")) || 0, sample };
}
