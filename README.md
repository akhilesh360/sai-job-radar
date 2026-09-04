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
   **Scan all boards** button runs steps 1–3 in a loop until every board is covered.
5. **Auto-refresh** — `worker/index.ts` exports a `scheduled()` handler (every 15 minutes, see
   `vite.config.ts`) that re-scans boards that are due: boards that have produced matching jobs every
   ~2 hours, quiet boards once a day. The dashboard itself reloads every 5 minutes and only shows the
   last 7 days.
   If the host does not run cron triggers, point any external scheduler at
   `POST /api/internal/hourly`.

6. **Discovery** — once a day (if `SERPER_API_KEY` is set) `lib/discovery.ts` runs 40 Google searches
   restricted to the ATS domains and the past 24 hours, purely to find company boards that are not in
   the catalog yet. New boards are staged, validated on the next scheduled run, and scanned. This costs
   about 80 Serper credits/day (~2,400/month; Serper gives 2,500 free, then $50 per 50,000).

## Local setup

Requirements: Node.js `>=22.13.0`, npm.

```bash
npm ci
npm run dev
```

The hosted version uses a Cloudflare D1 binding named `DB`. Optional env vars:

```text
SERPER_API_KEY     # daily Google discovery of new company boards (optional)
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
