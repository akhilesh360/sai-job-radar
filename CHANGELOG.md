# Sai Job Radar versions

## V2.1 — Working feed

- Fixed the US location filter, which rejected "Remote U.S.", "Remote (US)", "San Francisco", "New York" and most city-only locations.
- Broadened role matching to cover data platform / ML infra / research engineer / analyst titles; excludes managers, interns, sales, and data-center roles.
- Use Greenhouse `first_published` (not `updated_at`) as the posted date; the feed shows only the last 7 days (filters: 6h / 24h / 3d / 7d).
- "Scan all boards" now covers every active board in one click (looping 25 boards per request) instead of 40 boards per click.
- Added a Worker `scheduled()` handler on a 15-minute cron (productive boards every ~2h, quiet boards daily) and a 5-minute dashboard auto-reload, so new postings appear within hours without clicking.
- Jobs that disappear from a board get a `Closed` status automatically (and reopen as New if they come back); placeholder seed jobs are removed.
- Batched D1 writes so a scan stays inside Worker request limits.
- Google (Serper) is now used only for a once-a-day discovery of *new company boards* (~80 credits/day); jobs always come from the ATS feeds directly.
- Removed the Brave/Google job-search experiment, coverage audit, ChatGPT auth helper, and HTML-scraping connectors.

## V2.0 alpha 1 — Isolated coverage audit

- Kept V1.2.2 frozen as the stable rollback point.
- Added a read-only Coverage Audit view for Ashby, Greenhouse, and Lever.
- Added exact matching Brave and Google query links for the current two search groups.
- Added 1-day, 3-day, and 7-day comparison windows with Job Radar baseline counts.
- Kept the audit isolated from ATS jobs, application statuses, email alerts, and discovery schedules.

## V2.0 alpha 2 — Freshness-controlled audit runner

- Replaced the misleading saved-result date filter with six fresh Brave searches per audit window.
- Added Brave `pd`, exact three-day range, and `pw` freshness controls for 1-day, 3-day, and 7-day audits.
- Stored coverage-audit runs and candidates separately from Brave Test and the ATS Feed.
- Separated raw search candidates from authoritative ATS-validated US target-role jobs.
- Displayed search-indexed time and ATS-posted time independently.

## V1.2.2 — Brave-added ATS filter

- Added All discovery, Added from Brave, and ATS scan only filters to the ATS Feed.
- Marked manually promoted jobs with a visible BRAVE badge for faster application prioritization.

## V1.2.1 — Promotion hotfix

- Preserved Add to ATS Feed for validated jobs whose ATS returns a custom company careers URL, including Comeet-hosted jobs such as Solidus Labs.

## V1.1 — ATS and catalog baseline

Stable rollback point before the isolated Brave top-down discovery experiment.

- Consolidated US job feed for the defined target roles.
- Hourly collection support for Ashby, Greenhouse, Lever, and SmartRecruiters.
- Seeded catalog staging, source validation, deduplication, and application-status tracking.
- Posted and discovered timestamps with a seven-day default view.
- Daily Brave discovery currently used to identify and stage company boards.

V1.2 will keep Brave top-down job results isolated from the production ATS feed until their relevance and incremental coverage are measured.

## V1.2 — Stable Brave discovery and validation

- Added isolated persistent storage for raw Brave job-search results.
- Added a protected 30-request test endpoint using two keyword groups across all 15 ATS domains.
- Added a separate Brave Test view with its own metrics, result links, and one-click protected test button.
- Changed Run Brave Test into one pipeline: search, ATS validation, US/role filtering, canonical deduplication, and validated-only display.
- Added seven-day Brave defaults, recency and duplicate controls, newest-first sorting, coverage counts, and explicit promotion into the ATS Feed.
- Added public Brave validation connectors for Recruitee, Breezy, Workable, and JazzHR, including safe revalidation of the latest saved search run.
- Added an unsupported-ATS breakdown ranked by measured Brave candidate volume.
- Added validators for the three highest-yield remaining providers: Jobvite, Comeet, and Pinpoint.
- Prioritized candidates with Brave freshness signals from the last seven days before older or undated candidates.
- Verified the guarded Brave discovery, authoritative ATS validation, canonical deduplication, and explicit Add to ATS Feed promotion path.
- Split the production action into an ATS-only scan; it no longer launches Brave discovery.
- Added a 20-hour rerun guard so the free experiment cannot be triggered repeatedly by accident.
- Brave test records remain separate from the production ATS feed, email digest, and application totals.
- The table supports duplicate matching, new-company detection, target-role checks, US-location review, and manual relevance labels.
