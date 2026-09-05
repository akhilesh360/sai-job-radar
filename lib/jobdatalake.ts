import { env } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { getDb } from "../db";
import { sourceBoards } from "../db/schema";
import { enabledAts } from "./ats-connectors";
import { parseSourceUrl } from "./discovery";
import { isExcludedBoard } from "./exclusions";
import { getState, setState } from "./state";

/**
 * JobDataLake (api.jobdatalake.com) as a board finder, not a job source. Its index is built from ATS boards, so every
 * result carries the board's own URL. Once a day we ask for yesterday's US data roles and queue any Greenhouse / Lever /
 * Ashby / SmartRecruiters / Rippling board the catalog lacks as pending; validation and the normal scan take it from
 * there. Test on 2026-09-05: 7 unknown readable boards per 100 rows, at zero cost (Google discovery costs ~384 Serper
 * credits a run). Key: Workers Secret JDL_API_KEY (the owner's own signup key, not the one embedded in their MCP package).
 * Workday and other unreadable hosts are ignored here exactly as they are in Google discovery.
 */
const SYNC_EVERY_HOURS = 20;
const QUERIES = ["data engineer", "machine learning engineer", "analytics engineer"];

type JdlJob = { title?: string; company_name?: string; url?: string; countries?: string[] };

export async function syncJobDataLake(force = false) {
  const key = (env as unknown as { JDL_API_KEY?: string }).JDL_API_KEY;
  if (!key) return { configured: false as const, skipped: "no key" as const };
  const db = getDb();
  const last = await getState(db, "jdl_last_sync_at");
  if (!force && last && Date.now() - new Date(last).getTime() < SYNC_EVERY_HOURS * 3600_000) return { configured: true as const, skipped: "recent" as const, last };
  const found = new Map<string, ReturnType<typeof parseSourceUrl> & object>();
  let rows = 0;
  for (const q of QUERIES) {
    const params = new URLSearchParams({ q, countries: "US", posted_within: "24h", per_page: "100", sort_by: "posted_at:desc" });
    const response = await fetch(`https://api.jobdatalake.com/v1/jobs?${params}`, { headers: { "x-api-key": key, accept: "application/json", "user-agent": "SaiJobRadar/2.0" } });
    if (!response.ok) throw new Error(`JobDataLake HTTP ${response.status}`);
    const data = await response.json() as { jobs?: JdlJob[] };
    for (const job of data.jobs ?? []) {
      rows++;
      const parsed = job.url ? parseSourceUrl(job.url, "jobdatalake") : null;
      if (!parsed || !parsed.supported || !enabledAts.includes(parsed.ats) || isExcludedBoard(parsed)) continue;
      if (job.company_name && !/^[a-z0-9]+$/.test(job.company_name)) parsed.companyName = job.company_name; // JDL's name beats the slug, unless it is just the slug
      found.set(parsed.id, parsed);
    }
  }
  const ids = [...found.keys()];
  const known = new Set<string>();
  for (let index = 0; index < ids.length; index += 90) {
    for (const row of await db.select({ id: sourceBoards.id }).from(sourceBoards).where(inArray(sourceBoards.id, ids.slice(index, index + 90)))) known.add(row.id);
  }
  const fresh = ids.filter(id => !known.has(id)).map(id => found.get(id)!);
  const pending = fresh.map(source => ({ id: source.id, ats: source.ats, slug: source.slug, companyName: source.companyName, boardUrl: source.boardUrl, origin: "jobdatalake", status: "pending", active: false }));
  for (let index = 0; index < pending.length; index += 8) await db.insert(sourceBoards).values(pending.slice(index, index + 8)).onConflictDoNothing();
  await setState(db, "jdl_last_sync_at", new Date().toISOString());
  return { configured: true as const, rows, boardsSeen: ids.length, boardsQueued: pending.length, queued: pending.map(board => board.id) };
}
