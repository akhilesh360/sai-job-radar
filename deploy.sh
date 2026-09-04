#!/usr/bin/env bash
# One-shot Cloudflare deploy for Sai Job Radar. Run from the project folder:  bash deploy.sh
# Safe to re-run: every step skips what is already done.
set -euo pipefail
cd "$(dirname "$0")"

DB_NAME="${D1_DATABASE_NAME:-sai-job-radar}"
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "Checking Node.js"
command -v node >/dev/null || { echo "Node.js is not installed. Install it from https://nodejs.org (LTS) and re-run."; exit 1; }
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj<22||(maj===22&&min<13)) { console.error("Node 22.13+ required, found "+process.version); process.exit(1) }'

say "Installing dependencies"
[ -d node_modules ] || npm ci --no-audit --no-fund

say "Logging in to Cloudflare (a browser window opens the first time)"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

say "Creating the D1 database '$DB_NAME' (skipped if it exists)"
DB_ID="$(npx wrangler d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(r?r.uuid:"")}catch{}})' "$DB_NAME")"
if [ -z "$DB_ID" ]; then
  npx wrangler d1 create "$DB_NAME" >/dev/null
  DB_ID="$(npx wrangler d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(r?r.uuid:"")})' "$DB_NAME")"
fi
[ -n "$DB_ID" ] || { echo "Could not determine the D1 database id. Run 'npx wrangler d1 list' and check."; exit 1; }
printf 'D1_DATABASE_NAME=%s\nD1_DATABASE_ID=%s\n' "$DB_NAME" "$DB_ID" > .env
echo "Database id: $DB_ID (saved to .env)"

say "Creating tables (migrations are idempotent)"
for f in drizzle/0000_*.sql drizzle/0001_*.sql drizzle/0002_*.sql drizzle/0003_*.sql; do
  npx wrangler d1 execute "$DB_NAME" --remote --file "$f" -y >/dev/null 2>&1 || npx wrangler d1 execute "$DB_NAME" --remote --file "$f" -y || true
done

say "Building"
npm run build

say "Deploying"
CONFIG="$(find dist -name wrangler.json | head -1)"
[ -n "$CONFIG" ] || { echo "Build did not produce a wrangler.json under dist/; check the build output above."; exit 1; }
npx wrangler deploy --config "$CONFIG"

say "Serper key (Google discovery)"
if [ -n "${SERPER_API_KEY:-}" ]; then
  printf '%s' "$SERPER_API_KEY" | npx wrangler secret put SERPER_API_KEY --config "$CONFIG"
else
  echo "To turn on Google discovery, run:   npx wrangler secret put SERPER_API_KEY --config $CONFIG"
  echo "(it will prompt you to paste the key; it is stored encrypted on Cloudflare, never in this repo)"
fi

say "Done"
echo "Open the URL printed by 'Deploying' above, click 'Scan all boards' once, and you're live."
echo "Cron (every 15 min) is registered automatically — verify under Workers & Pages → sai-job-radar → Settings → Triggers."
