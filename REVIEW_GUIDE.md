# Sai Job Radar technical review guide

Please focus feedback on the current V2 architecture rather than UI polish.

## Highest-priority review areas

1. Concurrency and idempotency when multiple discovery cycles overlap.
2. Canonical URL and ATS job-ID normalization across search engines and connectors.
3. Whether the seven-day review queue should expire by `lastSeenAt`, `postedAt`, or both.
4. Retry and error classification for ATS validation failures.
5. Authorization for promotion, dismissal, and application-status writes.
6. Cost controls before scheduled Google orchestration is enabled.

## Current behavior

- Google discovers URLs; the ATS listing remains authoritative.
- Only verified US target-role jobs enter the review queue.
- Repeated discoveries update `lastSeenAt` instead of creating duplicates.
- Dismissed jobs remain hidden on later scans.
- Promoted jobs remain in the ATS Feed and preserve discovery origin.
- The queue retains verified results seen within the last seven days.

## Planned safeguards before automation

- Distributed/DB-backed run lock
- Idempotent run keys
- Bounded retries with failure categories
- Daily/monthly query budget enforcement
- Restore/undo view for dismissed results

Please flag correctness, data-loss, race-condition, privacy, or cost risks first.
