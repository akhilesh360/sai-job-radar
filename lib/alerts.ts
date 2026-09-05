import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { alertDeliveries, jobs } from "../db/schema";
import { visibleJobs } from "./visibility";

/**
 * Alerts for strong matches. Slack incoming webhook (secret SLACK_WEBHOOK_URL) is the channel; ntfy.sh (NTFY_TOPIC)
 * remains as a fallback but is rate-limited per source IP and rejects Cloudflare's shared egress (HTTP 429). The cron
 * calls this right after scoring; a job is sent once, when it first scores at or above MIN_ALERT_SCORE.
 */
export const MIN_ALERT_SCORE = 75;
const MAX_PER_RUN = 10;

export async function sendFitAlerts() {
  const bindings = env as unknown as { SLACK_WEBHOOK_URL?: string; NTFY_TOPIC?: string };
  const webhook = bindings.SLACK_WEBHOOK_URL, topic = bindings.NTFY_TOPIC;
  const channel = webhook ? "slack" : topic ? "ntfy" : null;
  if (!channel) return { configured: false as const, sent: 0, failed: 0 };
  const db = getDb();
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const candidates = await db.select().from(jobs)
    .where(and(eq(jobs.status, "New"), gte(jobs.fitScore, MIN_ALERT_SCORE), gt(jobs.fitScoredAt, since), visibleJobs))
    .orderBy(desc(jobs.fitScoredAt), desc(jobs.fitScore)).limit(60); // newest matches first: a fresh 76 must not wait behind old 90s
  if (!candidates.length) return { configured: true as const, sent: 0, failed: 0 };
  // Only successful deliveries block a re-send; a failed attempt is retried on the next pass.
  const already = new Set((await db.select({ jobId: alertDeliveries.jobId }).from(alertDeliveries)
    .where(and(eq(alertDeliveries.channel, channel), inArray(alertDeliveries.deliveryStatus, ["sent", "backfill"]), inArray(alertDeliveries.jobId, candidates.map(job => job.id))))).map(row => row.jobId));
  let sent = 0, failed = 0, lastError = "";
  for (const job of candidates.filter(job => !already.has(job.id)).slice(0, MAX_PER_RUN)) {
    const reason = (job.fitReason ?? "").split(/\n|;/)[0].trim();
    const body = [`${job.company} · ${job.location}${job.salary ? ` · ${job.salary}` : ""}`, reason].filter(Boolean).join("\n");
    let ok = false;
    try {
      const response = webhook
        ? await fetch(webhook, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: `${job.fitScore} · ${job.title} — ${job.company}`,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*${job.fitScore}* · <${job.applyUrl}|${job.title.replace(/[<>|]/g, " ")}>\n${job.company} · ${job.location}${job.salary ? ` · ${job.salary}` : ""}${reason ? `\n_${reason.replace(/[<>|]/g, " ")}_` : ""}` } },
              ],
            }),
          })
        : await fetch("https://ntfy.sh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ topic, title: `${job.fitScore} · ${job.title}`.slice(0, 200), message: body, click: job.applyUrl, tags: (job.fitScore ?? 0) >= 90 ? ["star", "briefcase"] : ["briefcase"], priority: (job.fitScore ?? 0) >= 90 ? 4 : 3 }),
          });
      ok = response.ok;
      if (!ok) lastError = `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`;
    } catch (error) { ok = false; lastError = error instanceof Error ? error.message : String(error); }
    if (ok) sent++; else failed++;
    await db.delete(alertDeliveries).where(and(eq(alertDeliveries.jobId, job.id), eq(alertDeliveries.channel, channel)));
    await db.insert(alertDeliveries).values({ jobId: job.id, channel, deliveryStatus: ok ? "sent" : "failed" }).onConflictDoNothing();
  }
  return { configured: true as const, channel, sent, failed, lastError: lastError || undefined };
}
