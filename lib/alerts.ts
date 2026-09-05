import { and, desc, eq, gt, gte, inArray, isNull, or } from "drizzle-orm";
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
const POSTED_WITHIN_HOURS = 24; // only postings from the last day are worth a ping

export async function sendFitAlerts(preview = 0) {
  const bindings = env as unknown as { SLACK_WEBHOOK_URL?: string; SLACK_MENTION?: string; NTFY_TOPIC?: string };
  const webhook = bindings.SLACK_WEBHOOK_URL, topic = bindings.NTFY_TOPIC;
  const channel = webhook ? "slack" : topic ? "ntfy" : null;
  if (!channel) return { configured: false as const, sent: 0, failed: 0 };
  const db = getDb();
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const postedSince = new Date(Date.now() - POSTED_WITHIN_HOURS * 60 * 60 * 1000).toISOString();
  const candidates = await db.select().from(jobs)
    // Posted (or, when the ATS gives no date, first seen) within the last day: an old posting on a newly added board is not news.
    .where(and(eq(jobs.status, "New"), gte(jobs.fitScore, MIN_ALERT_SCORE), gt(jobs.fitScoredAt, since), or(gt(jobs.postedAt, postedSince), and(isNull(jobs.postedAt), gt(jobs.discoveredAt, postedSince))), visibleJobs))
    .orderBy(desc(jobs.fitScoredAt), desc(jobs.fitScore)).limit(60); // newest matches first: a fresh 76 must not wait behind old 90s
  if (!candidates.length) return { configured: true as const, sent: 0, failed: 0 };
  // Only successful deliveries block a re-send; a failed attempt is retried on the next pass.
  const already = new Set((await db.select({ jobId: alertDeliveries.jobId }).from(alertDeliveries)
    .where(and(eq(alertDeliveries.channel, channel), inArray(alertDeliveries.deliveryStatus, ["sent", "backfill", "duplicate"]), inArray(alertDeliveries.jobId, candidates.map(job => job.id))))).map(row => row.jobId));
  let sent = 0, failed = 0, lastError = "";
  // Same company + same title alerted in the last 30 days = a re-post; do not alert it again.
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const recent = await db.select({ company: jobs.company, title: jobs.title }).from(alertDeliveries).innerJoin(jobs, eq(jobs.id, alertDeliveries.jobId))
    .where(and(eq(alertDeliveries.channel, channel), eq(alertDeliveries.deliveryStatus, "sent"), gt(alertDeliveries.sentAt, monthAgo))).limit(2000);
  const dupKey = (company: string, title: string) => `${company}|${title}`.toLowerCase().replace(/[^a-z0-9|]+/g, " ").trim();
  const seenPairs = new Set(recent.map(row => dupKey(row.company, row.title)));
  const fresh: typeof candidates = [];
  for (const job of candidates) {
    if (already.has(job.id)) continue;
    const key = dupKey(job.company, job.title);
    if (seenPairs.has(key)) { await db.insert(alertDeliveries).values({ jobId: job.id, channel, deliveryStatus: "duplicate" }).onConflictDoNothing(); continue; }
    seenPairs.add(key); fresh.push(job);
  }
  const batch = preview > 0 ? candidates.slice(0, Math.min(preview, MAX_PER_RUN)) : fresh.slice(0, MAX_PER_RUN);
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
  // Slack's table block: one row per match, the title cell is the apply link.
  const ago = (iso: string) => { const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3600000)); return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };
  const cell = (text: string) => ({ type: "raw_text", text: text || "-" });
  const tableRows = [
    ["Score", "Title", "Company", "Location", "Posted", "H-1B"].map(cell),
    ...rows.map(({ job, sponsor }) => [cell(String(job.fitScore)),
      { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "link", url: job.applyUrl, text: clean(job.title).slice(0, 80) }] }] },
      cell(clean(job.company).slice(0, 40)), cell(clean(job.location).slice(0, 40)), cell(ago(job.postedAt ?? job.discoveredAt)), cell(sponsor ? "yes" : "-")]),
  ];
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
              { type: "table", rows: tableRows },
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
