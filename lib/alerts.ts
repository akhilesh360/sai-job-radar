import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { alertDeliveries, h1bSponsors, jobs } from "../db/schema";
import { employerKey, matchSponsor, normalizeEmployer, type SponsorRow } from "./h1b";
import { visibleJobs } from "./visibility";

/**
 * Alerts for strong matches. Slack incoming webhook (secret SLACK_WEBHOOK_URL) is the channel; ntfy.sh (NTFY_TOPIC)
 * remains as a fallback but is rate-limited per source IP and rejects Cloudflare's shared egress (HTTP 429). The cron
 * calls this right after scoring; a job is sent once, when it first scores at or above MIN_ALERT_SCORE.
 */
export const MIN_ALERT_SCORE = 75;
const MAX_PER_RUN = 25; // one digest message per pass

export async function sendFitAlerts(preview = 0) {
  const bindings = env as unknown as { SLACK_WEBHOOK_URL?: string; SLACK_MENTION?: string; NTFY_TOPIC?: string };
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
  const batch = preview > 0 ? candidates.slice(0, Math.min(preview, MAX_PER_RUN)) : candidates.filter(job => !already.has(job.id)).slice(0, MAX_PER_RUN);
  if (!batch.length) return { configured: true as const, channel, sent, failed };
  // H-1B sponsor lookup, the same way the fit scorer does it, so sponsors can lead the list.
  const keys = [...new Set(batch.map(job => employerKey(normalizeEmployer(job.company))).filter(Boolean))];
  const byKey = new Map<string, SponsorRow[]>();
  for (let index = 0; index < keys.length; index += 90) {
    for (const row of await db.select().from(h1bSponsors).where(inArray(h1bSponsors.key1, keys.slice(index, index + 90)))) byKey.set(row.key1, [...(byKey.get(row.key1) ?? []), row]);
  }
  const rows = batch.map(job => ({ job, sponsor: matchSponsor(job.company, byKey.get(employerKey(normalizeEmployer(job.company))) ?? []) !== null }))
    .sort((a, b) => Number(b.sponsor) - Number(a.sponsor) || (b.job.fitScore ?? 0) - (a.job.fitScore ?? 0));
  const clean = (value: string) => value.replace(/[<>|`]/g, " ").replace(/\s+/g, " ").trim();
  const pad = (value: string, width: number) => (value.length > width ? value.slice(0, width - 1) + "…" : value).padEnd(width);
  // Slack has no table widget: a fixed-width table for scanning, then a numbered list of clickable links.
  const table = ["#   Score  H-1B  Title                              Company               Location", ...rows.map(({ job, sponsor }, index) =>
    `${pad(String(index + 1), 4)}${pad(String(job.fitScore), 7)}${pad(sponsor ? "yes" : "-", 6)}${pad(clean(job.title), 35)}${pad(clean(job.company), 22)}${pad(clean(job.location), 18)}`)].join("\n");
  const links = rows.map(({ job }, index) => `${index + 1}. <${job.applyUrl}|${clean(job.title).slice(0, 80)}> — ${clean(job.company)}${job.salary ? ` · ${job.salary}` : ""}`);
  const mention = bindings.SLACK_MENTION ?? "<!channel>";
  let ok = false;
  try {
    const response = webhook
      ? await fetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `${mention} ${rows.length} new match${rows.length === 1 ? "" : "es"} scoring ${MIN_ALERT_SCORE}+`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `${mention} *${rows.length} new match${rows.length === 1 ? "" : "es"} · ${MIN_ALERT_SCORE}+ · sponsors first, then score*` } },
              { type: "section", text: { type: "mrkdwn", text: "```" + table.slice(0, 2900) + "```" } },
              ...links.reduce<string[][]>((groups, line) => { const last = groups[groups.length - 1]; if (last && last.join("\n").length + line.length < 2800) last.push(line); else groups.push([line]); return groups; }, [])
                .map(group => ({ type: "section", text: { type: "mrkdwn", text: group.join("\n") } })),
            ],
          }),
        })
      : await fetch("https://ntfy.sh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic, title: `${rows.length} new matches ${MIN_ALERT_SCORE}+`, message: rows.map(({ job }) => `${job.fitScore} · ${job.title} — ${job.company}`).join("\n").slice(0, 4000) }),
        });
    ok = response.ok;
    if (!ok) lastError = `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`;
  } catch (error) { ok = false; lastError = error instanceof Error ? error.message : String(error); }
  if (ok) sent = rows.length; else failed = rows.length;
  if (preview > 0) return { configured: true as const, channel, sent, failed, preview: true, lastError: lastError || undefined };
  for (const { job } of rows) {
    await db.delete(alertDeliveries).where(and(eq(alertDeliveries.jobId, job.id), eq(alertDeliveries.channel, channel)));
    await db.insert(alertDeliveries).values({ jobId: job.id, channel, deliveryStatus: ok ? "sent" : "failed" }).onConflictDoNothing();
  }
  return { configured: true as const, channel, sent, failed, lastError: lastError || undefined };
}
