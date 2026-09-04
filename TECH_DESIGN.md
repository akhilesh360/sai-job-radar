# Job Radar — Technical Design & Architecture

**Version:** 2.1 · **Status:** Live on Cloudflare Workers (`https://<worker-name>.<account>.workers.dev`) · **Date:** September 2026

---

## 1. Purpose

A single-user job-discovery and application-tracking dashboard for US data / AI / engineering roles.
The goal is to surface a relevant job within hours of it being posted — before it reaches LinkedIn or
Google's index — and to track applications against it. It is optimised for one thing: apply first.

## 2. Design principles

1. **Go to the source.** Companies publish open roles on their applicant-tracking system (ATS) the
   moment a recruiter hits publish. Read those feeds directly instead of waiting for an aggregator.
2. **Top-down, not catalog-bound.** Google (via Serper) is used to discover *which companies* are
   hiring right now, so a company never seen before still shows up. The catalog is a cache, not a gate.
3. **Free to run.** Everything sits on Cloudflare's free tier; the only paid input is Serper credits.
4. **Nothing to babysit.** A cron trigger keeps the feed fresh; the page reloads itself.
5. **Precision over volume.** A ~200-title role list and a US-location filter keep the feed applyable.

## 3. High-level architecture

```
                         ┌───────────────────────────────────────────────────────────────┐
                         │                    CLOUDFLARE (free tier)                     │
                         │                                                               │
   Browser ──HTTPS──►    │   Worker "job-radar"                                            │
   (dashboard)           │   ┌─────────────────────────┐    ┌───────────────────────┐    │
                         │   │ fetch()  – app + /api/* │    │ scheduled()  – cron   │    │
                         │   │ (vinext / React 19)     │    │ every 5 min           │    │
                         │   └───────────┬─────────────┘    └──────────┬────────────┘    │
                         │               │                             │                 │
                         │               ▼                             ▼                 │
                         │        ┌────────────────────────────────────────────┐         │
                         │        │  lib/pipeline.ts · lib/discovery.ts        │         │
                         │        │  lib/ats-connectors.ts · roles · locations │         │
                         │        └───────┬───────────────────────┬────────────┘         │
                         │                │ drizzle-orm           │ fetch()              │
                         │                ▼                       │                      │
                         │        ┌──────────────┐                │                      │
                         │        │  D1 (SQLite) │                │   Secrets:           │
                         │        │  job-radar    │                │   SERPER_API_KEY     │
                         │        └──────────────┘                │                      │
                         └──────────────────────────────────────── │ ─────────────────────┘
                                                                   ▼
             ┌──────────────────────────────┐        ┌────────────────────────────────┐
             │ Public ATS JSON feeds (free) │        │ Serper (Google Search API)     │
             │ Greenhouse · Lever · Ashby   │        │ site:<ats-domain> "<titles>"   │
             │ Workable · SmartRecruiters   │        │ past 24 h, 16 domains × 6 grp  │
             │ Rippling · Recruitee · Breezy│        └────────────────────────────────┘
             │ Pinpoint                     │
             └──────────────────────────────┘
```

### Components

| Component | Technology | Role |
|---|---|---|
| Web app + API | vinext (Next.js-compatible on Vite), React 19, TypeScript | Dashboard UI and `/api/*` route handlers |
| Runtime | Cloudflare Workers (`worker/index.ts`) | Serves the app; exports `scheduled()` for cron |
| Scheduler | Workers Cron Trigger `*/15 * * * *` | Runs the maintenance cycle 96×/day |
| Database | Cloudflare D1 (SQLite) via drizzle-orm 0.45 | Jobs, boards, run logs, key/value state |
| Secrets | Workers Secrets | `SERPER_API_KEY`, optional `RESEND_API_KEY` |
| Search | Serper.dev (Google Search API) | Top-down discovery of new postings/companies |
| ATS connectors | Plain `fetch()` to public JSON endpoints | Authoritative job data, no keys |
| Build / deploy | `vinext build` → `wrangler deploy`; `deploy.sh` wraps setup | One-command deploy from a laptop |

## 4. Data flow

### 4.1 Scheduled cycle (every 5 minutes — `lib/scheduled.ts`)

```
cron ──► runScheduledMaintenance()
          │
          ├─ 1. discoverNewBoards()        if ≥ DISCOVERY_INTERVAL_HOURS (3) since last run
          │      96 Serper queries ─► parse result URLs ─► classify:
          │        • unknown company on supported ATS  → insert source_boards (pending)
          │        • known company                     → last_scanned_at = NULL  (scan first)
          │        • unsupported ATS (Workday, iCIMS…) → insert jobs (source "X (Google)", unverified)
          │
          ├─ 2. validatePendingSources(15–40)   fetch each pending board once →
          │        active (feed answered) | invalid (404 / error)
          │
          └─ 3. scanBoards({mode:"scheduled", limit:120})
                 due = NULL last_scanned_at
                     ∨ (last_job_count > 0 ∧ last_scanned_at < now-2h)
                     ∨ last_scanned_at < now-22h
                 for each due board: fetchBoardJobs() → filter → upsert jobs → close vanished jobs
```

### 4.2 Manual full scan (dashboard "Scan now" — `app/page.tsx`)

```
Google discovery (POST /api/internal/discover)
  → stage catalog (POST /api/sources, 250 seeds per call until complete)
  → validate pending (POST /api/internal/validate-sources, 30 per call until remaining = 0)
  → scan (POST /api/internal/ingest {limit:25, since}, until remaining = 0)
```
`since` is chosen by the server on the first call and echoed back, so the loop is finite regardless
of client/server clock skew. Progress and a Stop button are shown in the UI.

### 4.3 Per-board scan (`lib/pipeline.ts › upsertBoardJobs`)

1. `fetchBoardJobs(board)` — connector fetches the board's public JSON feed, maps each posting to a
   `CanonicalJob`, and keeps it only if `isTargetTitle(title) && isUsLocation(location)`.
2. Look up which canonical keys already exist (chunks of 90 — D1's 100-bind-parameter limit).
3. `INSERT … ON CONFLICT(canonical_key) DO UPDATE` in chunks of 6 rows (15 columns × 6 = 90 params),
   refreshing title/location/URLs/posted_at/last_seen_at; a `Closed` job that reappears becomes `New`.
4. Jobs from this board with `last_seen_at < scanStartedAt` and status `New`/`Saved` → `Closed`.
5. Update the board's `last_scanned_at`, `last_job_count`, failure counter. Three consecutive
   failures disable the board.
All writes for a board go through `db.batch()` — one round trip, atomic.

### 4.4 Read path

`GET /api/jobs` → last 2,000 jobs ordered by posted_at desc. The page filters client-side: strict 24-hour window
(1h / 6h / 12h / 24h), role family (`classifyRole`), status (Open = not Archived/Rejected/Closed),
source, workplace type, and free-text search. Reloads every 5 minutes.

## 5. Data model (D1 / drizzle — `db/schema.ts`)

| Table | Purpose | Key columns |
|---|---|---|
| `jobs` | One row per posting | `id` = `canonical_key` (`<ats>:<slug>:<external_id>`), `title`, `company`, `location`, `workplace`, `source`, `apply_url`, `posted_at`, `discovered_at`, `last_seen_at`, `status` (New / Saved / Applied / Interview / Rejected / Archived / Closed) |
| `source_boards` | One row per company board | `id` = `<ats>:<slug>`, `ats`, `slug`, `board_url`, `origin` (poc / uploaded-lists / spreadsheet-* / google-discovery), `status` (pending / active / invalid / error), `active`, `last_validated_at`, `last_scanned_at`, `last_job_count`, `consecutive_failures` |
| `ingestion_runs` | One row per scan call | counts: fetched / inserted / updated / failed |
| `discovery_runs` | One row per Google pass | `queries`, `results`, `new_sources`, `failed` |
| `alert_deliveries` | Email digest dedupe | `job_id`, `channel` |
| `system_state` | Key/value | `seed_catalog_offset`, `last_full_scan_at`, `last_scheduled_run_at`, `last_discovery_at`, `last_discovery_error`, `serper_credits_used` |

Legacy tables from v2.0 (`brave_results`, `coverage_audit_*`) remain in the migrations but are unused.

## 6. Key modules

| File | Responsibility |
|---|---|
| `lib/roles.ts` | Role families and a token-based title matcher (`data … engineer`, `ETL/Spark/Snowflake … developer`, `ML/LLM/RAG … engineer`, `GTM/growth … engineer`, `solutions/customer engineer, data/AI`, …). Excludes managers, directors, interns, sales reps, data-center, clinical, data-entry titles. Verified against a 205-title target list (205/205). |
| `lib/locations.ts` | US detection: explicit US tokens → foreign signals → state names → state codes → ~150 US cities → bare "Remote". Multi-location strings ("SF; London") pass if any segment is US. |
| `lib/ats-connectors.ts` | One `fetchBoardJobs()` with a branch per ATS (Ashby, Greenhouse, Lever, SmartRecruiters, Workable, Recruitee, Breezy, Pinpoint, Rippling, BambooHR and JobScore). Public JSON only; 12 s timeout; Greenhouse uses `first_published`. |
| `lib/pipeline.ts` | `validatePendingSources`, `scanBoards`, batched D1 writes, close/reopen logic. |
| `lib/discovery.ts` | Serper queries (16 domains × 6 phrase groups ≤ 32 words each, `tbs=qdr:d`), URL → board parsing, new-board staging, board bumping, unverified-job insertion, credit accounting, retry with backoff on 429/5xx (3 concurrent). |
| `lib/scheduled.ts` | The cron orchestration (discover → validate → scan). |
| `lib/source-catalog.ts` | Streams the 9,170-board seed catalog (`data/source-seeds-*.json`) into `source_boards` 250 at a time. |
| `app/api/*` | Thin route handlers: `jobs` (GET/PATCH), `sources` (GET stats / POST stage), `internal/ingest`, `internal/validate-sources`, `internal/discover`, `internal/hourly` (manual cron), `internal/digest` (optional email). |
| `app/page.tsx` | Client dashboard: stats tiles, filters, table, status dropdown, scan/discover buttons, footer health line. |
| `worker/index.ts` | `fetch()` (image optimisation + app) and `scheduled()` handlers. |
| `vite.config.ts` | Wrangler config (name, D1 binding from `.env`, `nodejs_compat`, cron trigger). |
| `deploy.sh` / `DEPLOY.md` | One-shot setup and deploy. |

## 7. External interfaces

| Service | Endpoint pattern | Auth | Cost |
|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | none | free |
| Lever | `api.lever.co/v0/postings/{slug}?mode=json` | none | free |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` | none | free |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{slug}/postings` | none | free |
| Workable | `apply.workable.com/api/v1/widget/accounts/{slug}` | none | free |
| Rippling | `api.rippling.com/platform/api/ats/v1/board/{slug}/jobs` | none | free |
| Recruitee / Breezy / Pinpoint | `{slug}.recruitee.com/api/offers/` · `{slug}.breezy.hr/json` · `{slug}.pinpointhq.com/postings.json` | none | free |
| Serper | `POST google.serper.dev/search` | `X-API-KEY` | 1 credit ≤ 10 results, 2 credits ≤ 100 |
| Resend (optional) | `POST api.resend.com/emails` | Bearer | free tier |

## 8. Scheduling, throughput and cost

| Activity | Cadence | Volume / day | Cost |
|---|---|---|---|
| Cron invocation | every 5 min | 288 | included (Workers Paid, $5/mo: 10M req + 30M CPU-ms/month) |
| Board scans | up to 120 boards per cron run | ~4–10k feed fetches | $0 (sub-requests) |
| D1 writes / reads | per scan | ~20–40k / ~10–30k | $0 (free: 100k writes, 5M reads) |
| Google discovery | every 3 h (`DISCOVERY_INTERVAL_HOURS`) | 8 runs × 156 credits ≈ 1,250 credits | ≈ $1.25/day from prepaid Serper pack; 48k credits ≈ 38 days |
| Dashboard refresh | every 5 min while open | ~300 requests | $0 |
| One-time full scan | on click | ~15k requests | $0 |

## 9. Reliability & safety

- **D1 limits**: every statement stays under 100 bound parameters (row chunks of 6, key chunks of 90);
  writes are batched (`db.batch`) so a scan uses few sub-requests and is atomic per board.
- **Finite loops**: server-issued `since` cursor; validation stops at `remaining = 0` or `checked = 0`.
- **Failure isolation**: a board that errors is marked and retried; three failures disable it.
  A dead catalog entry can never block other boards.
- **Rate limiting**: Serper calls run 3 at a time and retry 429/5xx with backoff; the last error is
  recorded in `system_state` and shown in the dashboard footer.
- **Secrets**: the Serper key is a Workers Secret; `.env` (local D1 id) is git-ignored; no keys in code.
- **Idempotency**: all inserts are upserts keyed on canonical ids; re-running any step is safe.
- **No self-fetch**: the cron calls library functions directly (a Worker cannot fetch its own hostname).

## 10. Deployment

```
npx wrangler login                 # once
bash deploy.sh                     # creates D1, applies migrations, builds, deploys, registers cron
npx wrangler secret put SERPER_API_KEY --config "$(find dist -name wrangler.json | head -1)"
```
Redeploy after code changes: `npx vinext build && npx wrangler deploy --config "$(find dist -name wrangler.json | head -1)"`.

## 11. Known limitations / future work

- Google discovery depends on Google indexing; the direct-feed path covers the gap for known companies.
- Unverified jobs (Workday, iCIMS, …) are not re-checked and are never auto-closed; they age out of the
  7-day window.
- Role/location matching is regex-based; a small false-positive rate is accepted in favour of recall.
- Possible next steps: resume-based fit score to rank the feed; per-company watch list; browser
  notification / email when a job is posted in the last hour; auto-fill assistance for applications.
