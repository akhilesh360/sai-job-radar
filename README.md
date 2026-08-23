# Sai Job Radar

Sai Job Radar is a US technical-job discovery and application-tracking dashboard. It combines Google-indexed ATS discovery with authoritative ATS validation, deduplication, a persistent seven-day review queue, and an approved-company monitoring feed.

## Current V2 checkpoint

- Google discovery across supported ATS domains using seven exact-title role families
- ATS validation for active role, canonical title, location, posted date, and job ID
- US and target-role filtering
- Fresh/older/duplicate separation with newest-first sorting
- Persistent seven-day Google review queue
- Add to ATS Feed and Dismiss review actions
- Discovery-origin preservation and company-board activation
- Application status tracking
- Read-only coverage audit surfaces

Production checkpoint source commit: `98be8581a58cfc14ce1984acb8275928adc550bd`

## Supported ATS validators

Ashby, Greenhouse, Lever, SmartRecruiters, Recruitee, Breezy, Workable, JazzHR, Jobvite, Comeet, and Pinpoint.

## Local setup

Requirements:

- Node.js `>=22.13.0`
- npm

```bash
npm ci
npm run dev
```

The hosted version uses a Cloudflare D1 binding named `DB`. Search discovery requires server-side environment variables:

```text
SERPER_API_KEY
BRAVE_SEARCH_API_KEY   # optional legacy/audit functionality
```

Never commit API-key values or `.env` files.

## Useful commands

```bash
npm run build
npm test
npm run db:generate
```

## Review priorities

See [REVIEW_GUIDE.md](REVIEW_GUIDE.md) for the areas where technical feedback is most useful.

## Security

This repository intentionally excludes hosted-site ownership configuration and all runtime secrets. API calls remain server-side.
