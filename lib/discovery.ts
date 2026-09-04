import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { discoveryRuns, sourceBoards } from "../db/schema";
import { enabledAts } from "./ats-connectors";
import { getState, setState } from "./state";

/**
 * Daily company discovery. Google (via Serper) is only used to find *company boards* we do not have
 * in the catalog yet; the jobs themselves always come straight from the ATS feeds, which are free and
 * faster than Google indexing. Newly found boards are staged as pending, validated by the next
 * scheduled run, and scanned right after — so a company you have never heard of still shows up.
 */

const atsHosts: Array<{ ats: string; hosts: string[] }> = [
  { ats: "Ashby", hosts: ["jobs.ashbyhq.com"] },
  { ats: "Greenhouse", hosts: ["job-boards.greenhouse.io", "boards.greenhouse.io"] },
  { ats: "Lever", hosts: ["jobs.lever.co"] },
  { ats: "Workable", hosts: ["apply.workable.com", "jobs.workable.com"] },
  { ats: "SmartRecruiters", hosts: ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"] },
  { ats: "Rippling", hosts: ["ats.rippling.com"] },
  { ats: "Recruitee", hosts: ["recruitee.com"] },
  { ats: "Breezy", hosts: ["breezy.hr"] },
  { ats: "Pinpoint", hosts: ["pinpointhq.com"] },
];

// Each query is `site:<domain> (<phrases>)` restricted to the past day. 10 domains × 4 groups = 40 queries.
export const discoveryDomains = atsHosts.flatMap(item => item.hosts).filter(host => host !== "jobs.workable.com" && host !== "careers.smartrecruiters.com");
export const discoveryPhraseGroups = [
  ["Data Engineer", "Data Platform Engineer", "Analytics Engineer", "ETL Engineer"],
  ["Data Scientist", "Data Analyst", "Business Intelligence Engineer", "BI Engineer"],
  ["Machine Learning Engineer", "ML Engineer", "AI Engineer", "Applied AI Engineer", "LLM Engineer"],
  ["Forward Deployed Engineer", "GTM Engineer", "Cloud Engineer", "AWS Engineer", "Product Engineer"],
];

export type ParsedSource = { id: string; ats: string; slug: string; companyName: string; boardUrl: string; origin: string };

export function parseSourceUrl(rawUrl: string, origin = "google-discovery"): ParsedSource | null {
  try {
    const url = new URL(rawUrl), host = url.hostname.toLowerCase(), parts = url.pathname.split("/").filter(Boolean);
    const match = atsHosts.find(item => item.hosts.some(value => host === value || host.endsWith(`.${value}`)));
    if (!match) return null;
    let slug = parts[0] ?? "";
    if (["Recruitee", "Breezy", "Pinpoint"].includes(match.ats)) slug = host.split(".")[0];
    if (match.ats === "Workable" && host === "jobs.workable.com") return null; // per-job pages, no company in the URL
    if (!slug || ["embed", "jobs", "job", "careers", "apply", "j", "o", "p"].includes(slug.toLowerCase())) return null;
    slug = decodeURIComponent(slug).trim().replace(/[?#].*$/, "");
    if (!/^[a-z0-9][a-z0-9._ -]{0,80}$/i.test(slug)) return null;
    const id = `${match.ats}:${slug}`.toLowerCase();
    const boardUrl = ["Recruitee", "Breezy", "Pinpoint"].includes(match.ats) ? `https://${host}` : `https://${host}/${encodeURIComponent(slug)}`;
    const companyName = slug.replace(/[-_.]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    return { id, ats: match.ats, slug, companyName, boardUrl, origin };
  } catch {
    return null;
  }
}

type SerperResponse = { organic?: Array<{ link?: string }> };

async function serperSearch(key: string, domain: string, phrases: string[]) {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ q: `site:${domain} (${phrases.map(phrase => `"${phrase}"`).join(" OR ")})`, gl: "us", hl: "en", tbs: "qdr:d", num: 100 }),
  });
  if (!response.ok) throw new Error(`Serper ${response.status}`);
  return response.json() as Promise<SerperResponse>;
}

export function discoveryConfigured() {
  return Boolean((env as unknown as { SERPER_API_KEY?: string }).SERPER_API_KEY);
}

export async function discoverNewBoards() {
  const key = (env as unknown as { SERPER_API_KEY?: string }).SERPER_API_KEY;
  if (!key) return { configured: false, queries: 0, results: 0, newSources: 0, failed: 0 };
  const db = getDb();
  const [run] = await db.insert(discoveryRuns).values({ status: "running" }).returning();
  const existing = new Set((await db.select({ id: sourceBoards.id }).from(sourceBoards)).map(row => row.id));
  const plans = discoveryDomains.flatMap(domain => discoveryPhraseGroups.map(phrases => ({ domain, phrases })));
  let queries = 0, results = 0, failed = 0;
  const found = new Map<string, ParsedSource>();
  for (let index = 0; index < plans.length; index += 8) {
    await Promise.all(plans.slice(index, index + 8).map(async plan => {
      try {
        const data = await serperSearch(key, plan.domain, plan.phrases);
        queries++;
        for (const item of data.organic ?? []) {
          results++;
          const parsed = item.link ? parseSourceUrl(item.link) : null;
          if (parsed && enabledAts.includes(parsed.ats) && !existing.has(parsed.id)) found.set(parsed.id, parsed);
        }
      } catch { failed++; }
    }));
  }
  const rows = [...found.values()].map(source => ({ ...source, status: "pending", active: false }));
  for (let index = 0; index < rows.length; index += 10) await db.insert(sourceBoards).values(rows.slice(index, index + 10)).onConflictDoNothing();
  const now = new Date().toISOString();
  await db.update(discoveryRuns).set({ finishedAt: now, status: failed === plans.length ? "failed" : failed ? "partial" : "succeeded", queries, results, newSources: rows.length, failed }).where(eq(discoveryRuns.id, run.id));
  await setState(db, "last_discovery_at", now);
  const used = Number(await getState(db, "serper_credits_used") ?? 0) + queries * 2; // num=100 costs 2 credits per query
  await setState(db, "serper_credits_used", String(used));
  return { configured: true, queries, results, newSources: rows.length, failed, creditsUsedTotal: used };
}

