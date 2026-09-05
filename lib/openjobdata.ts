import { and, eq, inArray } from "drizzle-orm";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { getDb } from "../db";
import { jobs, ojdCompanies, sourceBoards } from "../db/schema";
import { boardKeyPrefix, enabledAts, type CanonicalJob, type DiscoveredBoard, type SourceBoard } from "./ats-connectors";
import { isTargetTitle } from "./roles";
import { workplaceType } from "./locations";
import { upsertAggregatorJobs } from "./pipeline";
import { getState, setState } from "./state";

/**
 * openjobdata.com publishes a public dataset on Hugging Face: ~100k companies with their ATS, and a daily "changes"
 * parquet file (~5 MB, ~80k rows) of new/updated/closed postings across every ATS — including the ones we cannot read
 * (iCIMS, ADP, UKG, Paycom, Paylocity, JazzHR, Dayforce, ...). This sync runs a few times a day: it reads today's and
 * yesterday's files, keeps active US postings from the last three days whose title our classifier accepts, and
 *   - for companies on an ATS we read directly: queues the board if it is not in the catalog (the direct connector then
 *     carries the jobs, with real locations);
 *   - for every other ATS: upserts the posting as a row of its own (source "<ATS> (openjobdata)");
 *   - applies "closed" events to rows we hold.
 * Workday rows are skipped by the owner's standing decision (flip INCLUDE_WORKDAY to change that).
 */
const INCLUDE_WORKDAY = false;
const SYNC_EVERY_HOURS = 1; // they publish once a day at a wandering hour (2–9 AM Central seen); unchanged files cost one small fetch
const FRESH_DAYS = 3;
const BUCKET = "https://huggingface.co/buckets/Invicto69/Jobs-Dataset-bucket/resolve/data/minimal/changes";

const READABLE: Record<string, { ats: string; boardUrl: (slug: string) => string }> = {
  greenhouse: { ats: "Greenhouse", boardUrl: slug => `https://job-boards.greenhouse.io/${slug}` },
  ashbyhq: { ats: "Ashby", boardUrl: slug => `https://jobs.ashbyhq.com/${encodeURIComponent(slug)}` },
  lever: { ats: "Lever", boardUrl: slug => `https://jobs.lever.co/${slug}` },
  smartrecruiters: { ats: "SmartRecruiters", boardUrl: slug => `https://jobs.smartrecruiters.com/${slug}` },
  bamboohr: { ats: "BambooHR", boardUrl: slug => `https://${slug}.bamboohr.com/careers` },
  breezy: { ats: "Breezy", boardUrl: slug => `https://${slug}.breezy.hr` },
  rippling: { ats: "Rippling", boardUrl: slug => `https://ats.rippling.com/${slug}/jobs` },
  gem: { ats: "Gem", boardUrl: slug => `https://jobs.gem.com/${slug}` },
  pinpoint: { ats: "Pinpoint", boardUrl: slug => `https://${slug}.pinpointhq.com` },
  jobscore: { ats: "JobScore", boardUrl: slug => `https://careers.jobscore.com/careers/${slug}` },
};
const LABELS: Record<string, string> = { icims: "iCIMS", adp: "ADP", ultipro: "UKG", paycom: "Paycom", paylocity: "Paylocity", jazzhr: "JazzHR", dayforce: "Dayforce", isolved: "isolved", applicantpro: "ApplicantPro", jobvite: "Jobvite", csod: "Cornerstone", taleo: "Taleo", personio: "Personio", zoho: "Zoho Recruit", join: "JOIN", freshteam: "Freshteam", betterteam: "Betterteam", gohire: "GoHire", trakstar_hire: "Trakstar", recooty: "Recooty", workday: "Workday" };

type DeltaRow = { job_id?: string; company_id?: number | bigint; title?: string; country?: string; is_remote?: boolean; workplace_type?: string; posted_at?: Date | null; fetched_time?: Date | null; apply_url?: string; status?: string };

const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const toMs = (value: unknown) => (value instanceof Date ? value.getTime() : typeof value === "bigint" ? Number(value) / 1000 : typeof value === "number" ? (value > 1e14 ? value / 1000 : value) : value ? new Date(String(value)).getTime() : NaN);

async function readDelta(day: string, db: ReturnType<typeof getDb>, force: boolean) {
  const response = await fetch(`${BUCKET}/${day}.parquet`, { headers: { "user-agent": "SaiJobRadar/2.0" } });
  if (response.status === 404) return { rows: [] as DeltaRow[], skipped: "missing" as const };
  if (!response.ok) throw new Error(`openjobdata ${day}: HTTP ${response.status}`);
  const etag = response.headers.get("etag") ?? "";
  const stateKey = `ojd_etag_${day}`;
  if (!force && etag && (await getState(db, stateKey)) === etag) return { rows: [] as DeltaRow[], skipped: "unchanged" as const };
  const buffer = await response.arrayBuffer();
  const file = { byteLength: buffer.byteLength, slice: (start: number, end?: number) => buffer.slice(start, end) };
  const rows = await parquetReadObjects({ file, compressors, columns: ["job_id", "company_id", "title", "country", "is_remote", "workplace_type", "posted_at", "fetched_time", "apply_url", "status"] }) as DeltaRow[];
  if (etag) await setState(db, stateKey, etag);
  return { rows, skipped: null };
}

export async function syncOpenJobData(force = false) {
  const db = getDb();
  const last = await getState(db, "ojd_last_sync_at");
  if (!force && last && Date.now() - new Date(last).getTime() < SYNC_EVERY_HOURS * 60 * 60 * 1000) return { skipped: "not due" as const };
  const today = new Date(), yesterday = new Date(today.getTime() - 86400000);
  const files: Record<string, string> = {};
  const rows: DeltaRow[] = [];
  for (const day of [dateKey(yesterday), dateKey(today)]) {
    const result = await readDelta(day, db, force);
    files[day] = result.skipped ?? `${result.rows.length} rows`;
    rows.push(...result.rows);
  }
  const cutoff = Date.now() - FRESH_DAYS * 86400000;
  const isUs = (value: unknown) => /^(?:united states|usa?)$/i.test(String(value ?? "").trim());
  const fresh: DeltaRow[] = [], closed: DeltaRow[] = [];
  for (const row of rows) {
    if (!isUs(row.country) || !isTargetTitle(String(row.title ?? ""))) continue;
    if (row.status === "closed") { closed.push(row); continue; }
    const when = toMs(row.posted_at ?? row.fetched_time);
    if (row.status === "active" && Number.isFinite(when) && when >= cutoff) fresh.push(row);
  }
  // Company lookup (their company_id → name/ATS/slug), chunked for D1's parameter limit.
  const ids = [...new Set([...fresh, ...closed].map(row => Number(row.company_id)).filter(Number.isFinite))];
  const companies = new Map<number, { name: string; ats: string; slug: string; careerUrl: string | null }>();
  for (let index = 0; index < ids.length; index += 90) {
    for (const row of await db.select().from(ojdCompanies).where(inArray(ojdCompanies.id, ids.slice(index, index + 90)))) companies.set(row.id, { name: row.name, ats: row.ats, slug: row.slug, careerUrl: row.careerUrl });
  }
  const catalog = new Set((await db.select({ id: sourceBoards.id }).from(sourceBoards)).map(row => row.id));
  const boards = new Map<string, DiscoveredBoard>();
  const out: CanonicalJob[] = [];
  let readableRows = 0, workdayRows = 0;
  for (const row of fresh) {
    const company = companies.get(Number(row.company_id));
    if (!company) continue;
    let readable = READABLE[company.ats];
    let slug = company.slug;
    if (company.ats === "oracle_hcm") {
      // Oracle boards are read directly too; the board key is host--site, both present in the registry's career_url.
      const match = /^https?:\/\/([^/]+)\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/([^/?#]+)/i.exec(company.careerUrl ?? "");
      if (match) { slug = `${match[1]}--${match[2]}`; readable = { ats: "Oracle", boardUrl: () => `https://${match[1]}/hcmUI/CandidateExperience/en/sites/${match[2]}` }; }
      else { readableRows++; continue; }
    }
    if (readable) {
      readableRows++;
      const id = `${readable.ats}:${slug}`.toLowerCase();
      if (!catalog.has(id) && enabledAts.includes(readable.ats)) boards.set(id, { id, ats: readable.ats, slug, companyName: company.name, boardUrl: readable.boardUrl(slug), origin: "openjobdata-delta" });
      continue; // the direct connector carries this company's jobs, with real locations
    }
    if (company.ats === "workday" && !INCLUDE_WORKDAY) { workdayRows++; continue; }
    const label = LABELS[company.ats] ?? company.ats;
    const location = row.is_remote ? "Remote" : String(row.workplace_type ?? "").toLowerCase() === "hybrid" ? "Hybrid, United States" : "United States";
    const source: SourceBoard = { id: `openjobdata:${company.ats}`, ats: "openjobdata", slug: company.ats, companyName: company.name };
    const jobId = String(row.job_id ?? "").trim() || String(row.apply_url ?? "");
    const key = `${boardKeyPrefix(source)}${jobId}`.toLowerCase().replace(/[^a-z0-9:]+/g, "-");
    const now = new Date().toISOString();
    const postedAt = Number.isFinite(toMs(row.posted_at)) ? new Date(toMs(row.posted_at)).toISOString() : null;
    out.push({ id: key, canonicalKey: key, title: String(row.title).replace(/\s+/g, " ").trim(), company: company.name, location, workplace: workplaceType(location), source: `${label} (openjobdata)`, externalJobId: jobId, sourceUrl: String(row.apply_url ?? ""), applyUrl: String(row.apply_url ?? ""), salary: null, postedAt, discoveredAt: now, lastSeenAt: now, status: "New", isSeed: false });
  }
  const upsert = await upsertAggregatorJobs(out.filter(job => job.applyUrl));
  const queued = [...boards.values()].map(board => ({ ...board, status: "pending", active: false }));
  for (let index = 0; index < queued.length; index += 8) await db.insert(sourceBoards).values(queued.slice(index, index + 8)).onConflictDoNothing();
  // Closed events for rows we hold.
  const closedKeys = closed.map(row => { const company = companies.get(Number(row.company_id)); return company ? `openjobdata:${company.ats}:${String(row.job_id ?? "")}`.toLowerCase().replace(/[^a-z0-9:]+/g, "-") : ""; }).filter(Boolean);
  let closedApplied = 0;
  for (let index = 0; index < closedKeys.length; index += 90) {
    const result = await db.update(jobs).set({ status: "Closed" }).where(and(inArray(jobs.canonicalKey, closedKeys.slice(index, index + 90)), inArray(jobs.status, ["New", "Saved"]))).returning({ id: jobs.id });
    closedApplied += result.length;
  }
  await setState(db, "ojd_last_sync_at", new Date().toISOString());
  return { files, rowsRead: rows.length, freshMatching: fresh.length, readableRows, workdayRows, jobsUpserted: out.length, inserted: upsert.inserted, boardsQueued: queued.length, closedEvents: closed.length, closedApplied };
}
