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
5. **Auto-refresh** — `worker/index.ts` exports a `scheduled()` handler (hourly cron in
   `vite.config.ts`) that validates a slice of pending boards and re-scans the stalest active ones.
   If the host does not run cron triggers, point any external scheduler at
   `POST /api/internal/hourly`.

## Local setup

Requirements: Node.js `>=22.13.0`, npm.

```bash
npm ci
npm run dev
```

The hosted version uses a Cloudflare D1 binding named `DB`. Optional env vars:

```text
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
