/**
 * Dead-letter queue for source boards.
 *
 * A board that fails validation or repeatedly fails a scan is not thrown away: it is parked with a reason code and a
 * retry time. The cron re-probes due boards on a backoff schedule; a board that answers again goes straight back to
 * active, one that keeps failing is eventually marked dead (never probed again, still visible for inspection).
 */
export type FailureKind = "gone" | "blocked" | "transient" | "parse" | "excluded" | "unsupported";

const HOUR = 60 * 60 * 1000;

/**
 * Retry policy: every parked board is re-probed once a week, for up to eight weeks, then marked dead. Policy exclusions
 * and unsupported ATSs are dead at once. (A flat weekly cadence keeps the cron load predictable: ~5,000 parked boards
 * spread over a week is ~30 probes per hour.)
 */
const WEEK_HOURS = 168;
const MAX_WEEKLY_RETRIES = 8;
const RETRY_SCHEDULE: Record<FailureKind, number[]> = {
  transient: Array(MAX_WEEKLY_RETRIES).fill(WEEK_HOURS),
  blocked: Array(MAX_WEEKLY_RETRIES).fill(WEEK_HOURS),
  parse: Array(MAX_WEEKLY_RETRIES).fill(WEEK_HOURS),
  gone: Array(MAX_WEEKLY_RETRIES).fill(WEEK_HOURS),
  excluded: [],
  unsupported: [],
};

export function classifyFailure(message: string | null | undefined): FailureKind {
  const text = (message ?? "").trim();
  if (/^Excluded/i.test(text)) return "excluded";
  if (/not supported/i.test(text)) return "unsupported";
  const http = /HTTP (\d{3})/.exec(text);
  if (http) {
    const code = Number(http[1]);
    if (code === 404 || code === 410) return "gone";
    if (code === 401 || code === 403 || code === 429) return "blocked";
    return "transient";
  }
  if (/JSON|Unexpected token/i.test(text)) return "parse";
  return "transient";
}

/** Fields to write when a board fails: attempt count, next retry (or dead marker). `attempts` counts this failure. */
export function deadLetterFields(message: string | null | undefined, attempts: number, at = new Date()) {
  const failureKind = classifyFailure(message);
  const schedule = RETRY_SCHEDULE[failureKind];
  const delayHours = schedule[Math.max(0, attempts - 1)];
  const nextRetryAt = delayHours === undefined ? null : new Date(at.getTime() + delayHours * HOUR).toISOString();
  return { failureKind, retryCount: attempts, nextRetryAt, deadAt: nextRetryAt ? null : at.toISOString() };
}

/** Fields to write when a board answers again. */
export const recoveredFields = { failureKind: null, retryCount: 0, nextRetryAt: null, deadAt: null } as const;

export const failureKinds: FailureKind[] = ["gone", "blocked", "transient", "parse", "excluded", "unsupported"];
