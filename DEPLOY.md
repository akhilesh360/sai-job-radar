# Deploying Sai Job Radar to your own Cloudflare account

## Fastest path: one script

```bash
bash deploy.sh
```

It installs dependencies, logs you in to Cloudflare (browser window), creates the free D1 database,
creates the tables, builds, deploys, and tells you how to add the Serper key. Re-running it is safe.
The manual steps below are the same thing spelled out.


Everything runs on Cloudflare Workers Paid ($5/month — the free tier's 10 ms CPU limit kills scans): Workers (the app + the 5-minute cron), D1 (the database),
and Workers secrets (your Serper key). One-time setup is about 20 minutes; after that a redeploy is
`npm run build && npx wrangler deploy --config <generated config>`.

## 0. Prerequisites (on your Mac)

- Node.js 22.13+ (`node -v`)
- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- This repo checked out with the `fix/working-feed` changes applied, then `npm ci`

## 1. Log in to Cloudflare from the terminal

```bash
npx wrangler login
```

A browser window opens; approve it.

## 2. Create the database

```bash
npx wrangler d1 create sai-job-radar
```

Copy the `database_id` it prints (a UUID). Then create `.env` in the project root:

```text
D1_DATABASE_NAME=sai-job-radar
D1_DATABASE_ID=<paste the uuid here>
```

`.env` is git-ignored, so this never gets committed.

## 3. Create the tables

Apply the migrations in order (each is a plain SQL file):

```bash
for f in drizzle/0000_*.sql drizzle/0001_*.sql drizzle/0002_*.sql drizzle/0003_*.sql; do
  npx wrangler d1 execute sai-job-radar --remote --file "$f"
done
```

## 4. Build and deploy

```bash
npx vinext build            # (npm run build also works on Linux)
find dist -name wrangler.json        # note the path it prints, e.g. dist/rsc/wrangler.json
npx wrangler deploy --config dist/rsc/wrangler.json
```

The deploy prints your URL, e.g. `https://sai-job-radar.<your-subdomain>.workers.dev`, and registers
the `*/15 * * * *` cron trigger automatically (check: Cloudflare dashboard → Workers & Pages →
sai-job-radar → Settings → Triggers → Cron Triggers).

## 5. Add your Serper key (turns on Google discovery)

Cloudflare dashboard → Workers & Pages → sai-job-radar → Settings → Variables and Secrets → Add:

| Name | Type | Value |
|------|------|-------|
| `SERPER_API_KEY` | Secret | your serper.dev key |
| `DISCOVERY_INTERVAL_HOURS` | Text | `3` (or `2` for faster, more credits) |

Optional, for the email digest: `RESEND_API_KEY` (secret), `JOB_ALERT_EMAIL` (text).

Redeploy is not needed after adding variables.

## 6. First run

Open the URL and click **Scan all boards** once. It stages the ~9,200-company catalog, checks which
boards are alive, and scans every live one (10–15 minutes, progress shown). After that:

- every 5 minutes the cron re-reads up to 400 due boards (1,200 per 15 minutes), so productive boards are refreshed every 15–30 minutes depending on how many there are (footer shows "Auto-scan last ran …");
- every 3 hours it runs the Google discovery pass (footer shows credits used);
- the page reloads itself every 5 minutes.

## Updating later

```bash
git pull            # or apply a new patch
npm run build
npx wrangler deploy --config dist/rsc/wrangler.json
```

## Troubleshooting

- **`D1 binding DB is unavailable`** at runtime → `.env` was missing when you ran `npm run build`;
  rebuild and redeploy.
- **`no such table`** → step 3 was skipped or ran against the wrong database.
- **Cron not firing** → dashboard → Settings → Triggers should list `*/15 * * * *`. If it is missing,
  the build was made without `triggers` (check `vite.config.ts`) — rebuild and redeploy.
- **Google discovery says "off"** → `SERPER_API_KEY` is not set on the Worker (step 5).
- **Local dev**: `npm run dev` uses a local D1 automatically; no `.env` needed.

## H-1B sponsor data

The dashboard's "H-1B ✓" badge and "H-1B sponsors only" filter come from the USCIS H-1B Employer Data Hub. Load (or
refresh) the table after the migrations have run:

```bash
node scripts/load-h1b-sponsors.mjs 2023 2022          # newest fiscal years available on uscis.gov
npx wrangler d1 execute sai-job-radar --remote --file data/h1b-sponsors.sql -y
```
