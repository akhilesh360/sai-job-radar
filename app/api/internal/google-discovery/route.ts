import { desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../../db";
import { braveResults, discoveryRuns, jobs, sourceBoards, systemState } from "../../../../db/schema";
import { enabledAts, isUsLocation } from "../../../../lib/ats-connectors";
import { googleDiscoveryDomains, googleRoleFamilies, matchesTargetRole, parseSourceUrl } from "../../../../lib/job-discovery";

type SearchBindings = { SERPER_API_KEY?: string };
type SerperItem = { title?: string; link?: string; snippet?: string; date?: string; position?: number };
type SerperResponse = { organic?: SerperItem[]; credits?: number };

const MONTHLY_QUERY_LIMIT = 45_000;
const SEARCH_BATCH_SIZE = 25;
const atsByDomain: Record<string, string> = {
  "jobs.ashbyhq.com":"Ashby", "job-boards.greenhouse.io":"Greenhouse", "jobs.lever.co":"Lever",
  "ats.rippling.com":"Rippling", "apply.workable.com":"Workable", "jobs.smartrecruiters.com":"SmartRecruiters",
  "myworkdayjobs.com":"Workday", "jobs.jobvite.com":"Jobvite", "applytojob.com":"JazzHR",
  "recruitee.com":"Recruitee", "breezy.hr":"Breezy", "comeet.com/jobs":"Comeet",
  "pinpointhq.com":"Pinpoint", "icims.com/jobs":"iCIMS", "careers-page.com":"CareerPage",
  "boards.greenhouse.io":"Greenhouse", "jobs.teamtailor.com":"Teamtailor", "jobs.gem.com":"Gem",
  "workforcenow.adp.com":"ADP", "fa.ocs.oraclecloud.com":"Oracle",
};

function normalizeUrl(raw: string) {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
  return url.toString();
}

function likelyUs(text: string) {
  return /\b(United States|U\.S\.|USA|US Remote|Remote[, /-]+US|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia|Washington,? DC)\b/i.test(text);
}

function usageKey() { return `serper_usage_${new Date().toISOString().slice(0, 7)}`; }
async function getUsage() {
  const db = getDb(), key = usageKey();
  const row = await db.select({ value: systemState.value }).from(systemState).where(eq(systemState.key, key)).limit(1);
  return { key, used: Number(row[0]?.value ?? 0) || 0 };
}

async function search(key: string, domain: string, phrases: readonly string[], freshness: "day"|"week") {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ q: `site:${domain} (${phrases.map(phrase=>`"${phrase}"`).join(" OR ")})`, gl: "us", hl: "en", tbs: freshness==="week"?"qdr:w":"qdr:d", num: 10 }),
  });
  if (!response.ok) throw new Error(`Serper ${response.status}`);
  return response.json() as Promise<SerperResponse>;
}

export async function GET() {
  const db = getDb();
  const latestRun = await db.select().from(discoveryRuns).orderBy(desc(discoveryRuns.id)).limit(1);
  const usage = await getUsage();
  if (!latestRun[0]) return Response.json({ hasRun:false, provider:"Google", metrics:null, results:[], usage:{ month:usage.key.slice(-7), queries:usage.used, limit:MONTHLY_QUERY_LIMIT } });
  const run = latestRun[0];
  if (!run) return Response.json({ hasRun:false, provider:"Google", metrics:null, results:[], usage:{ month:usage.key.slice(-7), queries:usage.used, limit:MONTHLY_QUERY_LIMIT } });
  const candidates = await db.select().from(braveResults).where(eq(braveResults.discoveryRunId, run.id)).orderBy(desc(braveResults.lastSeenAt)).limit(2400);
  const queueCandidates = await db.select().from(braveResults).orderBy(desc(braveResults.lastSeenAt)).limit(5000);
  const queueCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const results = queueCandidates.filter(item => {
    const lastSeen = new Date(item.lastSeenAt).getTime();
    return item.verificationStatus === "verified" && item.reviewStatus !== "dismissed" && Number.isFinite(lastSeen) && lastSeen >= queueCutoff && isUsLocation(item.location ?? "");
  });
  const unsupported = candidates.filter(item => item.verificationStatus === "unsupported_ats");
  const unsupportedCounts = new Map<string,number>();
  for (const item of unsupported) unsupportedCounts.set(item.ats, (unsupportedCounts.get(item.ats) ?? 0) + 1);
  const unsupportedBreakdown = [...unsupportedCounts].map(([ats,count]) => ({ ats,count })).sort((a,b) => b.count-a.count || a.ats.localeCompare(b.ats));
  const newCompanies = new Set(results.filter(item=>item.isNewCompany).map(item=>`${item.ats}:${item.company??item.domain}`)).size;
  return Response.json({
    hasRun:true, provider:"Google", usage:{ month:usage.key.slice(-7), queries:usage.used, limit:MONTHLY_QUERY_LIMIT },
    metrics:{ status:run.status, runId:run.id, startedAt:run.startedAt, finishedAt:run.finishedAt,
      requestsAttempted:run.queries, failed:run.failed, rawResults:run.results, candidateResults:candidates.length,
      validationRemaining:candidates.filter(item=>item.verificationStatus==="search_result").length,
      excludedResults:candidates.filter(item=>item.verificationStatus!=="verified"&&item.verificationStatus!=="search_result").length,
      uniqueResults:results.length, targetRoleResults:results.length, confirmedUsResults:results.length,
      duplicates:results.filter(item=>item.isDuplicate).length, newCompanies,
      unsupportedAtsResults:unsupported.length, unsupportedBreakdown,
    }, results, queue:{ retentionDays:7, unreviewed:results.filter(item=>item.reviewStatus==="validated").length },
  });
}

export async function POST(request: Request) {
  const bindings = env as unknown as SearchBindings;
  if (!bindings.SERPER_API_KEY) return Response.json({ configured:false, message:"Google discovery is not configured." }, { status:503 });
  const body = await request.json().catch(()=>({})) as { runId?:number; cursor?:number; freshness?:"day"|"week" };
  const freshness=body.freshness==="week"?"week":"day";
  const db = getDb(), plans = googleDiscoveryDomains.flatMap(domain => googleRoleFamilies.map(family => ({ domain, role:family.key, phrases:family.phrases })));
  const cursor = Math.max(0, Math.min(Number(body.cursor ?? 0) || 0, plans.length));
  const usage = await getUsage();
  const remainingBudget = Math.max(0, MONTHLY_QUERY_LIMIT - usage.used);
  if (remainingBudget <= 0) return Response.json({ configured:true, paused:true, message:"Monthly Google query safety limit reached.", monthlyQueries:usage.used, monthlyLimit:MONTHLY_QUERY_LIMIT }, { status:429 });
  const selected = plans.slice(cursor, cursor + Math.min(SEARCH_BATCH_SIZE, remainingBudget));
  let runId = body.runId;
  if (!runId) runId = (await db.insert(discoveryRuns).values({ status:"running" }).returning())[0].id;
  const currentRun = (await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId)).limit(1))[0];
  if (!currentRun) return Response.json({ configured:true, message:"Discovery run was not found." }, { status:404 });

  let attempted = 0, failed = 0, rawResults = 0, successfulQueries = 0;
  const pages = await Promise.all(selected.map(async plan => {
    attempted++;
    try { const data = await search(bindings.SERPER_API_KEY!, plan.domain, plan.phrases, freshness); successfulQueries++; return { ...plan, data }; }
    catch { failed++; return { ...plan, data:null }; }
  }));

  const existingJobs = await db.select({ id:jobs.id, applyUrl:jobs.applyUrl, sourceUrl:jobs.sourceUrl }).from(jobs);
  const jobByUrl = new Map<string,string>();
  for (const job of existingJobs) for (const raw of [job.applyUrl,job.sourceUrl]) try { jobByUrl.set(normalizeUrl(raw).toLowerCase(), job.id); } catch {}
  const existingSourceIds = new Set((await db.select({id:sourceBoards.id}).from(sourceBoards)).map(row=>row.id));
  const now = new Date().toISOString();
  const unique = new Map<string,{domain:string;role:string;item:SerperItem;normalizedUrl:string}>();
  for (const page of pages) for (const item of page.data?.organic ?? []) {
    rawResults++;
    if (!item.link || !item.title) continue;
    try { const normalizedUrl=normalizeUrl(item.link), key=normalizedUrl.toLowerCase(); if(!unique.has(key)) unique.set(key,{domain:page.domain,role:page.role,item,normalizedUrl}); } catch {}
  }

  const entries = [...unique.entries()];
  for (let index=0; index<entries.length; index+=40) await Promise.all(entries.slice(index,index+40).map(async ([resultKey,result]) => {
    const parsed=parseSourceUrl(result.normalizedUrl,"google-discovery"), ats=parsed?.ats??atsByDomain[result.domain]??"Unknown";
    const title=result.item.title.trim(), snippet=result.item.snippet?.trim()??null, matchedJobId=jobByUrl.get(result.normalizedUrl.toLowerCase())??null;
    const values={ resultKey, discoveryRunId:runId!, ats, domain:result.domain, queryGroup:result.role, title,
      company:parsed?.companyName??null, location:null, resultUrl:result.normalizedUrl, snippet,
      postedAt:result.item.date??null, lastSeenAt:now, verificationStatus:enabledAts.includes(ats)?"search_result":"unsupported_ats",
      reviewStatus:enabledAts.includes(ats)?"unreviewed":"excluded", matchedJobId, isDuplicate:Boolean(matchedJobId),
      isNewCompany:Boolean(parsed&&!existingSourceIds.has(parsed.id)), isTargetRole:matchesTargetRole(title),
      usLocationStatus:likelyUs(`${title} ${snippet??""}`)?"confirmed":"unknown" };
    const { reviewStatus, ...refreshValues } = values;
    void reviewStatus;
    await db.insert(braveResults).values(values).onConflictDoUpdate({ target:braveResults.resultKey, set:refreshValues });
  }));

  const nextCursor = cursor + selected.length, done = nextCursor >= plans.length;
  const totalQueries = currentRun.queries + attempted, totalResults = currentRun.results + rawResults, totalFailed = currentRun.failed + failed;
  await db.update(discoveryRuns).set({ finishedAt:done?now:null, status:done?"validating":"running", queries:totalQueries, results:totalResults, failed:totalFailed }).where(eq(discoveryRuns.id,runId));
  const newUsage = usage.used + successfulQueries;
  await db.insert(systemState).values({key:usage.key,value:String(newUsage),updatedAt:now}).onConflictDoUpdate({target:systemState.key,set:{value:String(newUsage),updatedAt:now}});
  if (done) await db.insert(systemState).values({key:"last_google_discovery_at",value:now,updatedAt:now}).onConflictDoUpdate({target:systemState.key,set:{value:now,updatedAt:now}});
  return Response.json({ configured:true, provider:"Google", runId, cursor:nextCursor, done, requestsPlanned:plans.length,
    requestsAttempted:attempted, failed, rawResults, candidates:unique.size, monthlyQueries:newUsage, monthlyLimit:MONTHLY_QUERY_LIMIT });
}
