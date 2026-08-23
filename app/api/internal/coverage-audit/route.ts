import { desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../../db";
import { coverageAuditResults, coverageAuditRuns, sourceBoards } from "../../../../db/schema";
import { parseSourceUrl } from "../../../../lib/job-discovery";

type SearchBindings = { BRAVE_SEARCH_API_KEY?: string };
type BraveItem = { title?: string; url?: string; description?: string; page_age?: string; age?: string };
type BraveResponse = { web?: { results?: BraveItem[] } };

const providers = [
  { ats: "Ashby", domain: "jobs.ashbyhq.com" },
  { ats: "Greenhouse", domain: "job-boards.greenhouse.io" },
  { ats: "Lever", domain: "jobs.lever.co" },
] as const;
const queryGroups = {
  data_analytics: '"data" OR "analytics"',
  ai_engineering: '"AI" OR "machine learning" OR "ML" OR "GTM" OR "forward deployed" OR "product engineer" OR "cloud engineer" OR "AWS engineer" OR "GCP engineer"',
} as const;

function normalizeUrl(raw: string) {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
  return url.toString();
}

function freshnessFor(window: string) {
  if (window === "1 day") return "pd";
  if (window === "7 days") return "pw";
  const end = new Date(), start = new Date(end.getTime() - 3 * 86400000);
  return `${start.toISOString().slice(0, 10)}to${end.toISOString().slice(0, 10)}`;
}

async function search(key: string, domain: string, query: string, freshness: string) {
  const params = new URLSearchParams({
    q: `site:${domain} (${query})`, count: "20", offset: "0", country: "US",
    search_lang: "en", ui_lang: "en-US", safesearch: "moderate", operators: "true",
    text_decorations: "false", result_filter: "web", freshness,
  });
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { accept: "application/json", "x-subscription-token": key },
  });
  if (!response.ok) throw new Error(`Brave Search ${response.status}`);
  return response.json() as Promise<BraveResponse>;
}

export async function GET(request: Request) {
  const db = getDb(), window = new URL(request.url).searchParams.get("window") ?? "7 days";
  const [run] = await db.select().from(coverageAuditRuns).where(eq(coverageAuditRuns.window, window)).orderBy(desc(coverageAuditRuns.id)).limit(1);
  if (!run) return Response.json({ hasRun: false, run: null, results: [] });
  const results = await db.select().from(coverageAuditResults).where(eq(coverageAuditResults.auditRunId, run.id)).orderBy(coverageAuditResults.id).limit(200);
  return Response.json({ hasRun: true, run, results });
}

export async function POST(request: Request) {
  const bindings = env as unknown as SearchBindings;
  if (!bindings.BRAVE_SEARCH_API_KEY) return Response.json({ configured: false, message: "Brave Search is not configured." }, { status: 503 });
  const body = await request.json().catch(() => ({})) as { window?: string };
  const window = ["1 day", "3 days", "7 days"].includes(body.window ?? "") ? body.window! : "7 days";
  const freshness = freshnessFor(window), db = getDb();
  const [run] = await db.insert(coverageAuditRuns).values({ window, freshness }).returning();
  const plans = providers.flatMap(provider => Object.entries(queryGroups).map(([queryGroup, query]) => ({ ...provider, queryGroup, query })));
  let failed = 0, rawResults = 0;
  const pages = await Promise.all(plans.map(async plan => {
    try { return { ...plan, data: await search(bindings.BRAVE_SEARCH_API_KEY!, plan.domain, plan.query, freshness) }; }
    catch { failed++; return { ...plan, data: null }; }
  }));
  const activeBoards = new Set((await db.select({ id: sourceBoards.id }).from(sourceBoards).where(eq(sourceBoards.active, true))).map(row => row.id));
  const unique = new Set<string>();
  for (const page of pages) {
    for (const item of page.data?.web?.results ?? []) {
      rawResults++;
      if (!item.url || !item.title) continue;
      try {
        const resultUrl = normalizeUrl(item.url), resultKey = `${page.domain}:${page.queryGroup}:${resultUrl.toLowerCase()}`;
        if (unique.has(resultKey)) continue;
        unique.add(resultKey);
        const parsed = parseSourceUrl(resultUrl, "coverage-audit");
        await db.insert(coverageAuditResults).values({
          auditRunId: run.id, resultKey, ats: parsed?.ats ?? page.ats, domain: page.domain,
          queryGroup: page.queryGroup, title: item.title.trim(), company: parsed?.companyName ?? null,
          resultUrl, snippet: item.description?.trim() ?? null, searchIndexedAt: item.page_age ?? item.age ?? null,
          verificationStatus: parsed ? "search_result" : "invalid_url",
          isNewCompany: Boolean(parsed && !activeBoards.has(parsed.id)),
        });
      } catch { /* malformed search result */ }
    }
  }
  const now = new Date().toISOString(), status = failed === plans.length ? "failed" : failed ? "partial" : "validating";
  await db.update(coverageAuditRuns).set({ finishedAt: now, status, queries: plans.length, results: rawResults, failed }).where(eq(coverageAuditRuns.id, run.id));
  return Response.json({ configured: true, runId: run.id, window, freshness, queries: plans.length, rawResults, candidates: unique.size, failed });
}
