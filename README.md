# Sai Job Radar

A personal US job feed for data / AI / engineering roles. It pulls live openings straight from
company applicant-tracking-system (ATS) boards, filters them to US target roles, dedupes them, and
tracks your application status per job.

## How it works

1. **Catalog** — `data/source-seeds-*.json` lists ~9,200 company boards (Ashby, Greenhouse, Lever,
   SmartRecruiters, Workable, Rippling). `POST /api/sources` stages them into `source_boards`.
2. **Validate** — `POST /api/internal/validate-sources` checks pending boards; dead boards are marked
   `invalid`, live ones `active`.
3. **Scan** — `POST /api/internal/ingest` fetches every active board (25 per request, oldest-first) via
   the public JSON APIs in `lib/ats-connectors.ts`, keeps titles matched by `lib/roles.ts` and US
   locations matched by `lib/locations.ts`, upserts them into `jobs`, and marks jobs that have left a
   board as `Closed`.
4. **Dashboard** — `app/page.tsx` shows the feed with role / recency / status filters. The
   **Scan now** button runs the Google search, then steps 1–3, in a loop until every board is covered.
5. **Auto-refresh** — `worker/index.ts` exports a `scheduled()` handler (every 15 minutes, see
   `vite.config.ts`) that re-scans boards that are due: boards that have produced matching jobs every
   ~2 hours, quiet boards once a day. The dashboard itself reloads every 5 minutes and only shows roles
   posted in the last 24 hours.
   If the host does not run cron triggers, point any external scheduler at
   `POST /api/internal/hourly`.

6. **Top-down discovery** — every 3 hours (if `SERPER_API_KEY` is set; `DISCOVERY_INTERVAL_HOURS`
   to change) `lib/discovery.ts` runs 96 Google searches (16 ATS domains × 6 keyword groups built from
   the ~200 target titles in `lib/roles.ts`) restricted to the past 24 hours. Companies not yet in the
   catalog are added and scanned right away; known boards with a fresh hit are scanned first; postings
   on ATSs without a public API (Workday, iCIMS, Jobvite, JazzHR, Teamtailor, BambooHR) go straight into
   the feed marked *unverified*. Cost: 156 Serper credits per run, ~1,250/day at the default interval
   (a 50,000-credit pack lasts ~40 days; every 2 hours → ~27 days).

## Deploying

See [DEPLOY.md](DEPLOY.md) for deploying to your own Cloudflare account (free tier, ~20 minutes).

## Local setup

Requirements: Node.js `>=22.13.0`, npm.

```bash
npm ci
npm run dev
```

The hosted version uses a Cloudflare D1 binding named `DB`. Optional env vars:

```text
SERPER_API_KEY            # Google top-down discovery (optional but recommended)
DISCOVERY_INTERVAL_HOURS  # default 3
RESEND_API_KEY     # email digest
JOB_ALERT_EMAIL    # where the digest goes
JOB_ALERT_FROM     # optional sender
```

Never commit API-key values or `.env` files.

## Useful commands

```bash
npm run build
npm test
npm run lint
npm run db:generate
```
