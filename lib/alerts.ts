import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { alertDeliveries, jobs } from "../db/schema";
import { visibleJobs } from "./visibility";

/**
 * Phone push for strong matches, through ntfy.sh (free, no account: the topic name is the only secret). The cron
 * calls this right after scoring; a job is pushed once, when it first scores at or above MIN_ALERT_SCORE.
 * Set the topic with `wrangler secret put NTFY_TOPIC` and subscribe to it in the ntfy app.
 */
export const MIN_ALERT_SCORE = 75;
const MAX_PER_RUN = 10;

export async function sendFitAlerts() {
  const topic = (env as unknown as { NTFY_TOPIC?: string }).NTFY_TOPIC;
  if (!topic) return { configured: false as const, sent: 0, failed: 0 };
  const db = getDb();
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const candidates = await db.select().from(jobs)
    .where(and(eq(jobs.status, "New"), gte(jobs.fitScore, MIN_ALERT_SCORE), gt(jobs.fitScoredAt, since), visibleJobs))
    .orderBy(desc(jobs.fitScore), desc(jobs.discoveredAt)).limit(60);
  if (!candidates.length) return { configured: true as const, sent: 0, failed: 0 };
  const already = new Set((await db.select({ jobId: alertDeliveries.jobId }).from(alertDeliveries)
    .where(and(eq(alertDeliveries.channel, "ntfy"), inArray(alertDeliveries.jobId, candidates.map(job => job.id))))).map(row => row.jobId));
  let sent = 0, failed = 0;
  for (const job of candidates.filter(job => !already.has(job.id)).slice(0, MAX_PER_RUN)) {
    const reason = (job.fitReason ?? "").split(/\n|;/)[0].trim();
    const body = [`${job.company} · ${job.location}${job.salary ? ` · ${job.salary}` : ""}`, reason].filter(Boolean).join("\n");
    let ok = false;
    try {
      const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: { Title: `${job.fitScore} · ${job.title}`.slice(0, 200), Click: job.applyUrl, Tags: (job.fitScore ?? 0) >= 90 ? "star,briefcase" : "briefcase", Priority: (job.fitScore ?? 0) >= 90 ? "high" : "default" },
        body,
      });
      ok = response.ok;
    } catch { ok = false; }
    if (ok) sent++; else failed++;
    await db.insert(alertDeliveries).values({ jobId: job.id, channel: "ntfy", deliveryStatus: ok ? "sent" : "failed" }).onConflictDoNothing();
  }
  return { configured: true as const, sent, failed };
}
