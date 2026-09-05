import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { isTargetTitle } from "./roles";
import { isUsLocation, workplaceType } from "./locations";
import { atsKeyFromUrl, type CanonicalJob } from "./ats-connectors";
import { upsertAggregatorJobs } from "./pipeline";
import { getState, setState } from "./state";

/**
 * JobsPipe (api.jobspipe.dev) — one narrow daily query, not a feed. JobsPipe's index is mostly LinkedIn/Indeed copies
 * of postings whose ATS we cannot read, and the free plan is 1,000 returned rows a month, so the general stream is out
 * of reach. What it has that nothing else does is a parsed visa stance: `visa_sponsorship = "offers"` means the posting
 * itself says the employer sponsors. Once a day we pull US data roles posted in the last day with that stance (≈1–3
 * rows, so ≈50–100 credits a month). Key: Workers Secret JOBSPIPE_API_KEY. Owner decided 2026-09-05.
 */
const SYNC_EVERY_HOURS = 20;
const TITLES = ["data engineer", "data platform", "analytics engineer", "machine learning engineer", "data architect", "etl developer"];

type JobsPipeJob = {
  id?: string; job_title?: string; company?: string; company_domain?: string; final_url?: string; description?: string;
  date_posted?: string; discovered_at?: string; cities?: string[]; regions?: string[]; country_code?: string; remote?: boolean; hybrid?: boolean;
  sources?: Array<{ provider?: string; url?: string }>;
  visa_sponsorship?: string; avg_annual_salary_usd?: number; estimated_min_annual_salary_usd?: number; estimated_max_annual_salary_usd?: number;
};

export async function syncJobsPipe(force = false) {
  const key = (env as unknown as { JOBSPIPE_API_KEY?: string }).JOBSPIPE_API_KEY;
  if (!key) return { configured: false as const, skipped: "no key" as const };
  const db = getDb();
  const last = await getState(db, "jobspipe_last_sync_at");
  if (!force && last && Date.now() - new Date(last).getTime() < SYNC_EVERY_HOURS * 3600_000) return { configured: true as const, skipped: "recent" as const, last };
  const response = await fetch("https://api.jobspipe.dev/v1/jobs/search", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ job_title_or: TITLES, job_country_code_or: ["US"], visa_sponsorship_or: ["offers"], posted_at_max_age_days: 2, limit: 25 }),
  });
  if (!response.ok) throw new Error(`JobsPipe HTTP ${response.status}`);
  const data = await response.json() as { data?: JobsPipeJob[]; metadata?: { credits_used?: number } };
  const now = new Date().toISOString();
  const out: CanonicalJob[] = [];
  for (const raw of data.data ?? []) {
    const title = String(raw.job_title ?? "").trim(), company = String(raw.company ?? "").trim();
    // final_url is usually empty; the per-source links carry the posting. Prefer the employer's own ATS link over LinkedIn/Indeed.
    const links = (raw.sources ?? []).map(source => String(source.url ?? "")).filter(Boolean);
    const url = String(raw.final_url ?? "") || links.find(link => !/linkedin\.com|indeed\.com|ziprecruiter\.com|glassdoor\.com/i.test(link)) || links[0] || "";
    // cities come without a state; the country code is authoritative, so "San Mateo, United States".
    const place = [...(raw.cities ?? []), ...(raw.regions ?? [])].filter(Boolean).join(", ");
    const location = raw.remote ? (place ? `Remote, ${place}` : "Remote") : place ? `${place}, United States` : raw.country_code === "US" ? "United States" : "";
    if (!raw.id || !title || !company || !url || !isTargetTitle(title) || !isUsLocation(location)) continue;
    // A link into a board we read directly is keyed like that connector, so the two merge into one row.
    const direct = atsKeyFromUrl(url);
    const id = direct ? `${direct.ats}:${direct.slug}:${direct.jobId}`.toLowerCase().replace(/[^a-z0-9:]+/g, "-") : `jobspipe:sponsors:${raw.id}`.toLowerCase().replace(/[^a-z0-9:]+/g, "-");
    const salary = raw.estimated_min_annual_salary_usd && raw.estimated_max_annual_salary_usd
      ? `$${Math.round(raw.estimated_min_annual_salary_usd).toLocaleString("en-US")}–$${Math.round(raw.estimated_max_annual_salary_usd).toLocaleString("en-US")}` : null;
    out.push({
      id, canonicalKey: id, title, company, location: raw.hybrid && location !== "Remote" ? `${location} (Hybrid)` : location, workplace: workplaceType(raw.remote ? "Remote" : location),
      source: direct ? direct.ats : "JobsPipe (sponsors)", externalJobId: direct ? direct.jobId : String(raw.id), sourceUrl: url, applyUrl: url, salary,
      postedAt: raw.date_posted ? new Date(raw.date_posted).toISOString() : null, discoveredAt: now, lastSeenAt: now, status: "New", isSeed: false,
      jdText: raw.description ? String(raw.description).slice(0, 8000) : undefined,
    });
  }
  const upsert = await upsertAggregatorJobs(out);
  await setState(db, "jobspipe_last_sync_at", now);
  return { configured: true as const, returned: (data.data ?? []).length, kept: out.length, ...upsert, creditsUsed: data.metadata?.credits_used ?? null };
}
