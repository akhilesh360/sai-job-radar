import { eq, inArray } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { discoveryRuns, jobs, sourceBoards } from "../db/schema";
import { enabledAts } from "./ats-connectors";
import { isUsLocation, workplaceType } from "./locations";
import { isExcludedBoard } from "./exclusions";
import { classifyRole } from "./roles";
import { getState, setState } from "./state";

/**
 * Top-down discovery through Google (Serper). Every 3 hours (DISCOVERY_INTERVAL_HOURS) we ask Google for job pages posted in
 * the past day on every major ATS domain, then:
 *   1. Any company board we have never seen is added to the catalog, validated, and scanned right away.
 *   2. Any known board that Google shows a fresh job for is bumped to the front of the scan queue.
 *   3. Jobs on ATS platforms we cannot read directly (iCIMS, Jobvite, JazzHR, Teamtailor, ...). Workday results
 *      are ignored entirely: they arrive without a usable company name and are mostly non-US.
 *      are added straight to the feed from the search result, marked "unverified".
 * So a job shows up whether or not its company was in the database beforehand.
 */

type SearchBindings = { SERPER_API_KEY?: string; DISCOVERY_INTERVAL_HOURS?: string };
const bindings = () => env as unknown as SearchBindings;

const atsHosts: Array<{ ats: string; hosts: string[]; supported: boolean }> = [
  { ats: "Ashby", hosts: ["jobs.ashbyhq.com"], supported: true },
  { ats: "Greenhouse", hosts: ["job-boards.greenhouse.io", "boards.greenhouse.io"], supported: true },
  { ats: "Lever", hosts: ["jobs.lever.co"], supported: true },
  { ats: "Workable", hosts: ["apply.workable.com"], supported: true },
  { ats: "SmartRecruiters", hosts: ["jobs.smartrecruiters.com"], supported: true },
  { ats: "Rippling", hosts: ["ats.rippling.com"], supported: true },
  { ats: "Recruitee", hosts: ["recruitee.com"], supported: true },
  { ats: "Breezy", hosts: ["breezy.hr"], supported: true },
  { ats: "Pinpoint", hosts: ["pinpointhq.com"], supported: true },
  { ats: "iCIMS", hosts: ["icims.com"], supported: false },
  { ats: "Jobvite", hosts: ["jobs.jobvite.com"], supported: false },
  { ats: "JazzHR", hosts: ["applytojob.com"], supported: false },
  { ats: "Teamtailor", hosts: ["jobs.teamtailor.com"], supported: false },
  { ats: "BambooHR", hosts: ["bamboohr.com"], supported: true },
  { ats: "JobScore", hosts: ["careers.jobscore.com"], supported: true },
];

// Six keyword groups built from the target-title list (Google caps OR-queries at ~32 terms each).
export const discoveryPhraseGroups = [
  ["Data Engineer", "Data Platform Engineer", "Data Infrastructure Engineer", "Data Pipeline Engineer", "Data Integration Engineer", "DataOps Engineer", "Big Data Engineer", "Data Reliability Engineer", "Data Quality Engineer", "Data Governance Engineer", "Data Warehouse Engineer"],
  ["ETL Engineer", "ELT Engineer", "ETL Developer", "Databricks Engineer", "Snowflake Engineer", "Spark Developer", "PySpark Developer", "NiFi Engineer", "Streaming Data Engineer", "Azure Data Engineer", "AWS Data Engineer", "Cloud Data Engineer", "Dataiku", "Palantir Foundry"],
  ["Analytics Engineer", "Business Intelligence Engineer", "BI Engineer", "BI Developer", "Power BI Developer", "Analytics Developer", "Data Visualization Engineer", "Data Scientist", "Decision Scientist", "Data Analyst"],
  ["Machine Learning Engineer", "ML Engineer", "MLOps Engineer", "AI Engineer", "Applied AI Engineer", "Generative AI Engineer", "GenAI Engineer", "LLM Engineer", "RAG Engineer", "AI Platform Engineer", "Agentic AI Engineer", "NLP Engineer"],
  ["GTM Engineer", "Go To Market Engineer", "Growth Engineer", "Revenue Operations Engineer", "Forward Deployed", "Product Engineer", "Cloud Engineer", "AWS Engineer", "GCP Engineer", "Cloud Platform Engineer", "Cloud Infrastructure Engineer"],
  ["Software Engineer, Data", "Software Engineer, Data Platform", "Backend Engineer, Data", "Software Engineer, AI", "AI Software Engineer", "Software Engineer, Machine Learning", "Solutions Engineer, Data", "Solutions Engineer, AI", "Customer Engineer, Data", "ML Platform Engineer"],
];

// Supported domains get 100 results per query (2 credits); unsupported ones 10 results (1 credit).
const plans = atsHosts.flatMap(item => item.hosts.map(domain => ({ domain, ats: item.ats, supported: item.supported })))
  .flatMap(plan => discoveryPhraseGroups.map(phrases => ({ ...plan, phrases, num: plan.supported ? 100 : 10 })));
export const creditsPerDiscoveryRun = plans.reduce((sum, plan) => sum + (plan.num > 10 ? 2 : 1), 0);

export type ParsedSource = { id: string; ats: string; slug: string; companyName: string; boardUrl: string; origin: string; supported: boolean };

// Google occasionally hands back tracking/redirect links (google.com/url?q=…); unwrap them first.
export function unwrapRedirect(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === "/url") {
      const target = url.searchParams.get("q") ?? url.searchParams.get("url");
      if (target) return decodeURIComponent(target);
    }
  } catch {}
  return rawUrl;
}

export function parseSourceUrl(rawUrl: string, origin = "google-discovery"): ParsedSource | null {
  try {
    const url = new URL(unwrapRedirect(rawUrl)), host = url.hostname.toLowerCase(), parts = url.pathname.split("/").filter(Boolean);
    const match = atsHosts.find(item => item.hosts.some(value => host === value || host.endsWith(`.${value}`)));
    if (!match) return null;
    let slug = parts[0] ?? "";
    if (["Recruitee", "Breezy", "Pinpoint", "Teamtailor", "BambooHR", "iCIMS"].includes(match.ats)) slug = host.split(".")[0];
    // JobScore URLs are careers.jobscore.com/careers/<company>/... or /jobs/<company>/feed.json.
    if (match.ats === "JobScore") slug = ["careers", "jobs"].includes((parts[0] ?? "").toLowerCase()) ? parts[1] ?? "" : "";
    if (!slug || ["embed", "jobs", "job", "careers", "apply", "j", "o", "p", "www"].includes(slug.toLowerCase())) return null;
    slug = decodeURIComponent(slug).trim().replace(/[?#].*$/, "");
    if (!/^[a-z0-9][a-z0-9._ -]{0,80}$/i.test(slug)) return null;
    const id = `${match.ats}:${slug}`.toLowerCase();
    const boardUrl = match.ats === "JobScore" ? `https://${host}/careers/${encodeURIComponent(slug)}`
      : parts[0] === slug ? `https://${host}/${encodeURIComponent(slug)}` : `https://${host}`;
    const companyName = slug.replace(/[-_.]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    return { id, ats: match.ats, slug, companyName, boardUrl, origin, supported: match.supported };
  } catch {
    return null;
  }
}

type SerperItem = { title?: string; link?: string; snippet?: string; date?: string };
type SerperResponse = { organic?: SerperItem[] };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Serper rate-limits bursts; run a few at a time and retry 429/5xx with backoff.
async function serperSearch(key: string, plan: { domain: string; phrases: string[]; num: number }) {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(700 * attempt);
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ q: `site:${plan.domain} (${plan.phrases.map(phrase => `"${phrase}"`).join(" OR ")})`, gl: "us", hl: "en", tbs: "qdr:d", num: plan.num }),
    });
    if (response.ok) return response.json() as Promise<SerperResponse>;
    lastError = `Serper ${response.status} ${(await response.text().catch(() => "")).slice(0, 120)}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(lastError || "Serper request failed");
}

function normalizeUrl(raw: string) {
  const url = new URL(raw);
  url.hash = ""; url.search = "";
  url.pathname = url.pathname.replace(/\/(?:apply|application)\/?$/i, "").replace(/\/+$/g, "") || "/";
  return url.toString();
}

// Google titles look like "Senior Data Engineer - Acme Corp" or "Data Scientist | Acme | Workday".
function splitTitle(raw: string, fallbackCompany: string) {
  const parts = raw.split(/\s+[-|–—·]\s+/).map(part => part.trim()).filter(Boolean);
  const title = parts[0] ?? raw.trim();
  const company = parts.slice(1).find(part => !/\b(?:job|jobs|careers?|workday|icims|apply|greenhouse|lever)\b/i.test(part)) ?? fallbackCompany;
  return { title, company };
}

function guessLocation(text: string) {
  const match = text.match(/\b(?:Remote(?:[ -]+(?:US|USA|U\.S\.|United States))?|[A-Z][a-zA-Z.]+(?: [A-Z][a-zA-Z.]+)?,\s?(?:[A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)(?:,\s?(?:USA?|United States))?|United States)\b/);
  return match?.[0] ?? "";
}

export function discoveryConfigured() { return Boolean(bindings().SERPER_API_KEY); }
export function discoveryIntervalHours() { return Math.max(1, Number(bindings().DISCOVERY_INTERVAL_HOURS ?? 3) || 3); }

export async function discoverNewBoards() {
  const key = bindings().SERPER_API_KEY;
  if (!key) return { configured: false as const, queries: 0, results: 0, newSources: 0, bumpedBoards: 0, unverifiedJobs: 0, failed: 0 };
  const db = getDb();
  const [run] = await db.insert(discoveryRuns).values({ status: "running" }).returning();
  const existing = new Set((await db.select({ id: sourceBoards.id }).from(sourceBoards)).map(row => row.id));
  let queries = 0, results = 0, failed = 0, credits = 0, lastError = "";
  const newBoards = new Map<string, ParsedSource>();
  const seenBoards = new Set<string>();
  const unverified = new Map<string, typeof jobs.$inferInsert>();
  const now = new Date().toISOString();

  for (let index = 0; index < plans.length; index += 3) {
    await Promise.all(plans.slice(index, index + 3).map(async plan => {
      let data: SerperResponse;
      try { data = await serperSearch(key, plan); queries++; credits += plan.num > 10 ? 2 : 1; } catch (error) { failed++; lastError = error instanceof Error ? error.message : String(error); return; }
      for (const item of data.organic ?? []) {
        results++;
        if (!item.link) continue;
        item.link = unwrapRedirect(item.link);
        const parsed = parseSourceUrl(item.link);
        if (!parsed || isExcludedBoard(parsed)) continue;
        if (parsed.supported && enabledAts.includes(parsed.ats)) {
          if (existing.has(parsed.id)) seenBoards.add(parsed.id); else newBoards.set(parsed.id, parsed);
          continue;
        }
        // Unsupported ATS: keep the search result itself when it looks like a US target role.
        const { title, company } = splitTitle(item.title ?? "", parsed.companyName);
        const text = `${item.title ?? ""} ${item.snippet ?? ""}`;
        const location = guessLocation(text) || (/\bremote\b/i.test(text) ? "Remote" : "");
        if (!classifyRole(title) || !isUsLocation(location)) continue;
        let url: string;
        try { url = normalizeUrl(item.link); } catch { continue; }
        const canonicalKey = `google:${url.toLowerCase()}`;
        if (unverified.has(canonicalKey)) continue;
        unverified.set(canonicalKey, {
          id: canonicalKey, canonicalKey, title, company, location, workplace: workplaceType(location),
          source: `${parsed.ats} (Google)`, externalJobId: null, sourceUrl: url, applyUrl: url,
          postedAt: item.date && !Number.isNaN(new Date(item.date).getTime()) ? new Date(item.date).toISOString() : now, discoveredAt: now, lastSeenAt: now, status: "New", isSeed: false,
        });
      }
    }));
  }

  // 1. New company boards → pending; the scheduled run validates and scans them immediately after.
  const rows = [...newBoards.values()].map(source => ({ id: source.id, ats: source.ats, slug: source.slug, companyName: source.companyName, boardUrl: source.boardUrl, origin: source.origin, status: "pending", active: false }));
  for (let index = 0; index < rows.length; index += 10) await db.insert(sourceBoards).values(rows.slice(index, index + 10)).onConflictDoNothing();
  // 2. Known boards with a fresh Google hit → scan first (NULL last_scanned_at sorts first).
  const bump = [...seenBoards];
  for (let index = 0; index < bump.length; index += 90) await db.update(sourceBoards).set({ lastScannedAt: null }).where(inArray(sourceBoards.id, bump.slice(index, index + 90)));
  // 3. Unverified jobs from unsupported ATSs go straight into the feed (never overwrite a job you already have).
  const unverifiedRows = [...unverified.values()];
  for (let index = 0; index < unverifiedRows.length; index += 6) await db.insert(jobs).values(unverifiedRows.slice(index, index + 6)).onConflictDoNothing();

  const finished = new Date().toISOString();
  await db.update(discoveryRuns).set({ finishedAt: finished, status: failed === plans.length ? "failed" : failed ? "partial" : "succeeded", queries, results, newSources: rows.length, failed }).where(eq(discoveryRuns.id, run.id));
  await setState(db, "last_discovery_at", finished);
  const used = Number(await getState(db, "serper_credits_used") ?? 0) + credits;
  await setState(db, "serper_credits_used", String(used));
  if (failed) await setState(db, "last_discovery_error", `${failed} of ${plans.length} searches failed — ${lastError}`); else await setState(db, "last_discovery_error", "");
  return { configured: true as const, queries, results, newSources: rows.length, bumpedBoards: bump.length, unverifiedJobs: unverifiedRows.length, failed, lastError, creditsUsedTotal: used };
}
