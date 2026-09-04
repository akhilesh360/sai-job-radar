#!/usr/bin/env node
/**
 * Resolve the job boards of Y Combinator companies that are currently hiring in the US.
 *
 * Source: https://yc-oss.github.io/api/companies/all.json (daily public dataset, no key).
 * For each company we try a few slug guesses against the public APIs of the ATSs startups use
 * (Ashby, Greenhouse, Lever, Workable, Rippling) and keep the first board that answers with a
 * valid jobs payload. Output: data/source-seeds-9.json in the shape the catalog importer expects.
 *
 *   node scripts/resolve-yc-boards.mjs            # writes data/source-seeds-9.json
 *   CONCURRENCY=8 node scripts/resolve-yc-boards.mjs
 */
import { writeFileSync } from "node:fs";

const UA = "SaiJobRadar/2.0 (board resolver)";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
const isUs = loc => /\bUSA?\b|United States|Remote/i.test(loc ?? "");

const companies = await (await fetch("https://yc-oss.github.io/api/companies/all.json", { headers: { "user-agent": UA } })).json();
const targets = companies.filter(c => c.isHiring && c.status !== "Inactive" && isUs(c.all_locations));
console.error(`YC companies: ${companies.length}, hiring in the US: ${targets.length}`);

const clean = s => (s ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
const dashed = s => (s ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function guesses(c) {
  const domain = (() => { try { return new URL(c.website).hostname.replace(/^www\./, "").split(".")[0]; } catch { return ""; } })();
  return [...new Set([c.slug, clean(c.name), dashed(c.name), domain, clean(domain)].filter(s => s && s.length >= 2))];
}

// Each probe returns the number of jobs on the board, or null when the slug does not exist there.
async function get(url, init = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12_000);
  try { const r = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json", "user-agent": UA, ...(init.headers ?? {}) } }); if (!r.ok) return null; return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}
const probes = {
  Ashby:       async s => { const j = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=false`); return Array.isArray(j?.jobs) ? j.jobs.length : null; },
  Greenhouse:  async s => { const j = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`); return Array.isArray(j?.jobs) ? j.jobs.length : null; },
  Lever:       async s => { const j = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`); return Array.isArray(j) ? j.length : null; },
  Workable:    async s => { const j = await get(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s)}`); return Array.isArray(j?.jobs) ? j.jobs.length : null; },
  Rippling:    async s => { const j = await get(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(s)}/jobs`); const items = Array.isArray(j) ? j : j?.items; return Array.isArray(items) ? items.length : null; },
};
const boardUrl = { Ashby: s => `https://jobs.ashbyhq.com/${s}`, Greenhouse: s => `https://job-boards.greenhouse.io/${s}`, Lever: s => `https://jobs.lever.co/${s}`, Workable: s => `https://apply.workable.com/${s}`, Rippling: s => `https://ats.rippling.com/${s}` };

// Sanity: an impossible slug must resolve to null on every ATS, otherwise the "unknown" signature is wrong.
for (const [ats, probe] of Object.entries(probes)) { const r = await probe("zzqx-no-such-company-98765"); if (r !== null) { console.error(`ABORT: ${ats} returned a payload for a nonsense slug (${r})`); process.exit(1); } }

const found = [], misses = [];
let next = 0, done = 0;
async function worker() {
  while (next < targets.length) {
    const c = targets[next++];
    let hit = null;
    outer: for (const slug of guesses(c)) for (const [ats, probe] of Object.entries(probes)) {
      const n = await probe(slug);
      if (n !== null) { hit = { id: `${ats}:${slug}`.toLowerCase(), ats, slug, companyName: c.name, boardUrl: boardUrl[ats](slug), origin: "yc", jobs: n, batch: c.batch }; break outer; }
    }
    if (hit) found.push(hit); else misses.push(c.name);
    if (++done % 100 === 0) console.error(`  ${done}/${targets.length} checked, ${found.length} boards found`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const byAts = {}; for (const b of found) byAts[b.ats] = (byAts[b.ats] ?? 0) + 1;
console.error(`done: ${found.length} boards (${JSON.stringify(byAts)}), ${misses.length} companies not on a readable ATS`);
writeFileSync("data/source-seeds-9.json", JSON.stringify(found.map(({ jobs, batch, ...seed }) => seed)));
writeFileSync(new URL("../.wrangler/yc-resolver-report.json", import.meta.url), JSON.stringify({ found, misses }, null, 1));
console.error("wrote data/source-seeds-9.json");
