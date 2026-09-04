#!/usr/bin/env node
/**
 * Build the h1b_sponsors table from USCIS H-1B Employer Data Hub exports.
 *
 *   node scripts/load-h1b-sponsors.mjs 2023 2022     # fiscal years, newest first (default: 2023 2022)
 *
 * Downloads https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-<FY>.csv (or reads
 * ./.wrangler/h1b-<FY>.csv if present), sums initial + continuing approvals per normalized employer name across the
 * given years, and writes data/h1b-sponsors.sql — multi-row INSERT OR REPLACE statements to load with
 *   npx wrangler d1 execute sai-job-radar --remote --file data/h1b-sponsors.sql -y
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeEmployer, employerKey } from "../lib/h1b.ts";

const years = process.argv.slice(2).map(Number).filter(Boolean);
if (!years.length) years.push(2023, 2022);
const FILES_PAGE = "https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub/h-1b-employer-data-hub-files";

function parseCsvLine(line) {
  const out = []; let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}

const agg = new Map(); // nameNorm → { names: Map<raw, count>, approvals, fiscalYear, states: Map }
for (const year of years) {
  mkdirSync(".wrangler", { recursive: true });
  const cache = `.wrangler/h1b-${year}.csv`;
  let text;
  if (existsSync(cache)) text = readFileSync(cache, "utf8");
  else {
    const r = await fetch(`https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-${year}.csv`, { headers: { "user-agent": "Mozilla/5.0 SaiJobRadar/2.0", referer: FILES_PAGE } });
    text = await r.text();
    if (!r.ok || !text.startsWith('"Fiscal Year"')) { console.error(`FY${year}: not available (${r.status})`); continue; }
    writeFileSync(cache, text);
  }
  const lines = text.split(/\r?\n/).filter(Boolean); const header = parseCsvLine(lines[0]);
  const col = name => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const [iEmp, iIA, iCA, iState] = [col("Employer"), col("Initial Approval"), col("Continuing Approval"), col("State")];
  let rows = 0;
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line); const raw = (f[iEmp] ?? "").trim(); if (!raw) continue;
    const approvals = (Number(f[iIA]) || 0) + (Number(f[iCA]) || 0); if (!approvals) continue;
    const norm = normalizeEmployer(raw); if (!norm) continue;
    const a = agg.get(norm) ?? { names: new Map(), approvals: 0, fiscalYear: 0, states: new Map() };
    a.names.set(raw, (a.names.get(raw) ?? 0) + approvals); a.approvals += approvals; a.fiscalYear = Math.max(a.fiscalYear, year);
    const st = (f[iState] ?? "").trim(); if (st) a.states.set(st, (a.states.get(st) ?? 0) + approvals);
    agg.set(norm, a); rows++;
  }
  console.error(`FY${year}: ${rows} rows with approvals`);
}
const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const q = v => v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const entries = [...agg.entries()].map(([norm, a]) => [norm, top(a.names), employerKey(norm), a.fiscalYear, a.approvals, top(a.states)]);
const statements = ["DELETE FROM h1b_sponsors;"];
for (let i = 0; i < entries.length; i += 200) {
  const values = entries.slice(i, i + 200).map(([n, name, k, fy, ap, st]) => `(${q(n)},${q(name)},${q(k)},${fy},${ap},${q(st)})`).join(",\n");
  statements.push(`INSERT OR REPLACE INTO h1b_sponsors (name_norm,name,key1,fiscal_year,approvals,state) VALUES\n${values};`);
}
writeFileSync("data/h1b-sponsors.sql", statements.join("\n"));
console.error(`employers: ${entries.length} → data/h1b-sponsors.sql (${statements.length - 1} insert statements)`);
