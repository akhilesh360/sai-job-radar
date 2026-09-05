/**
 * Dead-letter queue for source boards.
 *
 * A board that fails validation or repeatedly fails a scan is not thrown away: it is parked with a reason code and a
 * retry time. The cron re-probes due boards on a backoff schedule; a board that answers again goes straight back to
 * active, one that keeps failing is eventually marked dead (never probed again, still visible for inspection).
 */
export type FailureKind = "gone" | "blocked" | "transient" | "parse" | "excluded" | "unsupported";

const HOUR = 60 * 60 * 1000;

/** Retry delays (hours) per failure kind, indexed by how many attempts have already failed. Empty = dead at once. */
const RETRY_SCHEDULE: Record<FailureKind, number[]> = {
  transient: [1, 6, 24, 72, 168],        // network / 5xx: retry quickly, give up after a week
  blocked: [24, 72, 168, 336],           // 401/403/429: the host may lift the block; back off hard
  parse: [24, 72, 168],                  // HTML where JSON was expected: usually a moved board
  gone: [168, 720],                      // 404/410: boards do occasionally come back; check weekly, then monthly
  excluded: [],                          // policy exclusion (federal, aggregators): never retry
  unsupported: [],                       // ATS we have no connector for
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
