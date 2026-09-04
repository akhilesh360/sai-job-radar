import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { sourceBoards } from "../../../db/schema";
import { ensureDefaultSources } from "../../../lib/pipeline";
import { getState } from "../../../lib/state";
import { creditsPerDiscoveryRun, discoveryConfigured, discoveryIntervalHours } from "../../../lib/discovery";
import { getCatalogOffset, importSourceSeedBatch, sourceSeedCount } from "../../../lib/source-catalog";

export async function GET() {
  const db = getDb();
  await ensureDefaultSources(db);
  const rows = await db.select({ ats: sourceBoards.ats, status: sourceBoards.status, active: sourceBoards.active, count: sql<number>`count(*)` }).from(sourceBoards).groupBy(sourceBoards.ats, sourceBoards.status, sourceBoards.active);
  const byAts: Record<string, number> = {};
  let total = 0, active = 0, pending = 0, invalid = 0, errored = 0;
  for (const row of rows) {
    const count = Number(row.count);
    total += count; byAts[row.ats] = (byAts[row.ats] ?? 0) + count;
    if (row.active) active += count;
    if (row.status === "pending") pending += count;
    if (row.status === "invalid") invalid += count;
    if (row.status === "error") errored += count;
  }
  const catalogOffset = await getCatalogOffset();
  const [lastFullScanAt, lastScheduledRunAt, lastDiscoveryAt, serperCreditsUsed] = await Promise.all([getState(db, "last_full_scan_at"), getState(db, "last_scheduled_run_at"), getState(db, "last_discovery_at"), getState(db, "serper_credits_used")]);
  const lastDiscoveryError = await getState(db, "last_discovery_error");
  const discovered = await db.select({ count: sql<number>`count(*)` }).from(sourceBoards).where(eq(sourceBoards.origin, "google-discovery"));
  const oldest = await db.select({ at: sql<string | null>`min(${sourceBoards.lastScannedAt})` }).from(sourceBoards).where(eq(sourceBoards.active, true));
  return Response.json({ total, active, pending, invalid, errored, byAts, seedCatalogSize: sourceSeedCount, catalogOffset, catalogComplete: catalogOffset >= sourceSeedCount, lastFullScanAt, lastScheduledRunAt, oldestScanAt: oldest[0]?.at ?? null, discoveryConfigured: discoveryConfigured(), discoveryIntervalHours: discoveryIntervalHours(), creditsPerDiscoveryRun, lastDiscoveryAt, lastDiscoveryError: lastDiscoveryError || null, discoveredBoards: Number(discovered[0]?.count ?? 0), serperCreditsUsed: Number(serperCreditsUsed ?? 0) });
}

/** Stage the next batch of catalog boards as pending sources. */
export async function POST(request: Request) {
  await ensureDefaultSources(getDb());
  const body = await request.json().catch(() => ({})) as { offset?: number; limit?: number };
  const offset = body.offset ?? await getCatalogOffset();
  return Response.json(await importSourceSeedBatch(offset, body.limit ?? 250));
}
