import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { coverageAuditResults, coverageAuditRuns, jobs } from "../../../../db/schema";
import { fetchBoardJobs, type CanonicalJob, type SourceBoard } from "../../../../lib/ats-connectors";
import { parseSourceUrl } from "../../../../lib/job-discovery";

function normalizeUrl(raw: string) {
  const url = new URL(raw); url.hash = ""; url.search = "";
  url.pathname = url.pathname.replace(/\/(?:application|apply)\/?$/i, "").replace(/\/+$/g, "") || "/";
  return url.toString().toLowerCase();
}
function matchesCandidate(url: string, job: CanonicalJob) {
  try {
    const haystack = decodeURIComponent(url).toLowerCase();
    return haystack.includes(job.externalJobId.toLowerCase()) || normalizeUrl(url) === normalizeUrl(job.applyUrl) || normalizeUrl(url) === normalizeUrl(job.sourceUrl);
  } catch { return false; }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { runId?: number };
  if (!body.runId) return Response.json({ done: true, remaining: 0, processed: 0, verified: 0, excluded: 0 });
  const db = getDb();
  const pending = await db.select().from(coverageAuditResults)
    .where(and(eq(coverageAuditResults.auditRunId, body.runId), eq(coverageAuditResults.verificationStatus, "search_result")))
    .orderBy(coverageAuditResults.id).limit(200);
  const groups = new Map<string, { source: SourceBoard; rows: typeof pending }>();
  for (const row of pending) {
    const parsed = parseSourceUrl(row.resultUrl, "coverage-audit");
    if (!parsed) {
      await db.update(coverageAuditResults).set({ verificationStatus: "invalid_url" }).where(eq(coverageAuditResults.id, row.id));
      continue;
    }
    if (!groups.has(parsed.id) && groups.size >= 3) continue;
    const group = groups.get(parsed.id) ?? { source: { id: parsed.id, ats: parsed.ats, slug: parsed.slug, companyName: parsed.companyName }, rows: [] };
    group.rows.push(row); groups.set(parsed.id, group);
  }
  const existing = await db.select({ id: jobs.id, canonicalKey: jobs.canonicalKey }).from(jobs);
  const jobIds = new Map(existing.map(item => [item.canonicalKey, item.id]));
  let processed = 0, verified = 0, excluded = 0;
  await Promise.all([...groups.values()].map(async group => {
    let boardJobs: CanonicalJob[];
    try { boardJobs = await fetchBoardJobs(group.source); }
    catch {
      for (const row of group.rows) {
        processed++; excluded++;
        await db.update(coverageAuditResults).set({ verificationStatus: "validation_error" }).where(eq(coverageAuditResults.id, row.id));
      }
      return;
    }
    for (const row of group.rows) {
      processed++;
      const job = boardJobs.find(item => matchesCandidate(row.resultUrl, item));
      if (!job) {
        excluded++;
        await db.update(coverageAuditResults).set({ verificationStatus: "expired_irrelevant_or_non_us" }).where(eq(coverageAuditResults.id, row.id));
        continue;
      }
      const matchedJobId = jobIds.get(job.canonicalKey) ?? null; verified++;
      await db.update(coverageAuditResults).set({
        title: job.title, company: job.company, location: job.location, resultUrl: job.applyUrl,
        postedAt: job.postedAt, verificationStatus: "verified", matchedJobId, isDuplicate: Boolean(matchedJobId),
      }).where(eq(coverageAuditResults.id, row.id));
    }
  }));
  const remaining = (await db.select({ id: coverageAuditResults.id }).from(coverageAuditResults)
    .where(and(eq(coverageAuditResults.auditRunId, body.runId), eq(coverageAuditResults.verificationStatus, "search_result"))).limit(200)).length;
  if (remaining === 0) await db.update(coverageAuditRuns).set({ status: "succeeded", finishedAt: new Date().toISOString() }).where(eq(coverageAuditRuns.id, body.runId));
  return Response.json({ done: remaining === 0, remaining, processed, verified, excluded });
}
