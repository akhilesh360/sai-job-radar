#!/usr/bin/env node
/**
 * Mark employers that filed certified H-1B Labor Condition Applications in a fiscal year (DOL LCA disclosure data).
 *
 *   node scripts/load-lca-employers.mjs <employers.md|.csv> <fiscalYear>
 *
 * Input: a markdown table or CSV with an Employer column (and optionally State). Output: data/h1b-lca-<FY>.sql that
 * sets h1b_sponsors.lca_latest_fy for employers already known from USCIS data and inserts the rest with 0 approvals.
 * Load with:  npx wrangler d1 execute sai-job-radar --remote --file data/h1b-lca-<FY>.sql -y
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeEmployer, employerKey } from "../lib/h1b.ts";

const [file, fyArg] = process.argv.slice(2);
if (!file || !fyArg) { console.error("usage: load-lca-employers.mjs <employers.md|.csv> <fiscalYear>"); process.exit(1); }
const fy = Number(fyArg);
const text = readFileSync(file, "utf8");

// Rows: markdown "| Employer | State |" or CSV with a header naming the employer column.
const employers = new Map(); // norm → { names: Map<raw,count>, states: Map }
function add(raw, state) {
  raw = raw.trim(); if (!raw || /^employer$/i.test(raw) || /^-+$/.test(raw)) return;
  const norm = normalizeEmployer(raw); if (norm.length < 2) return;
  const e = employers.get(norm) ?? { names: new Map(), states: new Map() };
  e.names.set(raw, (e.names.get(raw) ?? 0) + 1); if (state) e.states.set(state, (e.states.get(state) ?? 0) + 1);
  employers.set(norm, e);
}
if (/^\s*\|/m.test(text)) for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*\|\s*(.+?)\s*\|\s*([A-Z]{2})?\s*\|?\s*$/); if (m) add(m[1], m[2] ?? ""); }
else {
  const lines = text.split(/\r?\n/).filter(Boolean); const header = lines[0].toLowerCase().split(",");
  const ie = header.findIndex(h => /employer/.test(h)), is = header.findIndex(h => /state/.test(h));
  const parse = l => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
  for (const l of lines.slice(1)) { const f = parse(l); add(f[ie] ?? "", is >= 0 ? f[is] ?? "" : ""); }
}
console.error(`${file}: ${employers.size} distinct employers (normalized)`);

// Which of them does the USCIS table already know? (name_norm values in data/h1b-sponsors.sql)
const known = new Set([...readFileSync("data/h1b-sponsors.sql", "utf8").matchAll(/\('((?:[^']|'')*)','(?:[^']|'')*','(?:[^']|'')*',\d+,\d+,/g)].map(m => m[1].replace(/''/g, "'")));
const knownHits = [...employers.keys()].filter(n => known.has(n)); const fresh = [...employers.keys()].filter(n => !known.has(n));
console.error(`already in USCIS data: ${knownHits.length} | new employers: ${fresh.length}`);

const q = v => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const statements = [];
for (let i = 0; i < knownHits.length; i += 500) statements.push(`UPDATE h1b_sponsors SET lca_latest_fy=${fy} WHERE (lca_latest_fy IS NULL OR lca_latest_fy < ${fy}) AND name_norm IN (${knownHits.slice(i, i + 500).map(q).join(",")});`);
for (let i = 0; i < fresh.length; i += 200) {
  const values = fresh.slice(i, i + 200).map(n => { const e = employers.get(n); return `(${q(n)},${q(top(e.names))},${q(employerKey(n))},${fy},0,${q(top(e.states))},${fy})`; }).join(",\n");
  statements.push(`INSERT OR IGNORE INTO h1b_sponsors (name_norm,name,key1,fiscal_year,approvals,state,lca_latest_fy) VALUES\n${values};`);
}
writeFileSync(`data/h1b-lca-${fy}.sql`, statements.join("\n"));
console.error(`wrote data/h1b-lca-${fy}.sql (${statements.length} statements)`);
