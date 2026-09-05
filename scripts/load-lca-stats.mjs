#!/usr/bin/env node
/**
 * Load per-employer-year H-1B LCA stats produced by the DOL disclosure aggregation (lca_agg.csv: employer, fy, lcas,
 * positions, data_lcas, data_wage_p25/median/p75, top_states, top_data_titles) into h1b_lca_stats, and make sure every
 * employer exists in h1b_sponsors with lca_latest_fy set.
 *
 *   node scripts/load-lca-stats.mjs ~/h1b-data/lca_agg.csv
 *   npx wrangler d1 execute sai-job-radar --remote --file data/h1b-lca-stats.sql -y
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeEmployer, employerKey } from "../lib/h1b.ts";

const file = process.argv[2]; if (!file) { console.error("usage: load-lca-stats.mjs <lca_agg.csv>"); process.exit(1); }
const parse = l => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); const header = parse(lines[0]); const col = n => header.indexOf(n);
const merged = new Map(); // `${norm}|${fy}` → stats (several legal spellings of one employer fold together)
const employers = new Map(); // norm → { name, fy, states }
for (const line of lines.slice(1)) {
  const f = parse(line); const raw = f[col("employer")]; const fy = Number(f[col("fy")]); if (!raw || !fy) continue;
  const norm = normalizeEmployer(raw); if (norm.length < 2) continue;
  const key = `${norm}|${fy}`; const m = merged.get(key) ?? { lcas: 0, positions: 0, data: 0, w25: [], w50: [], w75: [], states: {}, titles: {} };
  const lcas = Number(f[col("lcas")]) || 0, data = Number(f[col("data_lcas")]) || 0;
  m.lcas += lcas; m.positions += Number(f[col("positions")]) || 0; m.data += data;
  for (const [k, c] of [["w25", "data_wage_p25"], ["w50", "data_wage_median"], ["w75", "data_wage_p75"]]) { const v = Number(f[col(c)]); if (v) m[k].push([v, data]); }
  for (const st of (f[col("top_states")] || "").split(",").filter(Boolean)) m.states[st] = (m.states[st] || 0) + lcas;
  // some cells come out of the xlsx wrapped as ="…" (Excel formula-text escape); unwrap them
  for (const t of (f[col("top_data_titles")] || "").split(" | ").map(t => t.replace(/^="?|"$/g, "").trim()).filter(Boolean)) m.titles[t] = (m.titles[t] || 0) + data;
  merged.set(key, m);
  const e = employers.get(norm) ?? { name: raw, fy: 0, best: 0, states: {} };
  if (lcas > e.best) { e.name = raw; e.best = lcas; } e.fy = Math.max(e.fy, fy); for (const st in m.states) e.states[st] = (e.states[st] || 0) + m.states[st]; employers.set(norm, e);
}
const wavg = pairs => { const tot = pairs.reduce((s, [, n]) => s + n, 0); return tot ? Math.round(pairs.reduce((s, [v, n]) => s + v * n, 0) / tot) : null; };
const q = v => v === null || v === undefined || v === "" ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
const statements = ["DELETE FROM h1b_lca_stats;"];
const rows = [...merged.entries()].map(([key, m]) => { const [norm, fy] = key.split("|"); return `(${q(norm)},${fy},${m.lcas},${m.positions},${m.data},${q(wavg(m.w25))},${q(wavg(m.w50))},${q(wavg(m.w75))},${q(top(m.states, 3).join(",") || null)},${q(top(m.titles, 3).join(" | ") || null)})`; });
for (let i = 0; i < rows.length; i += 200) statements.push(`INSERT OR REPLACE INTO h1b_lca_stats (name_norm,fiscal_year,lcas,positions,data_lcas,data_wage_p25,data_wage_median,data_wage_p75,top_states,top_data_titles) VALUES\n${rows.slice(i, i + 200).join(",\n")};`);
// sponsors table: insert unknown employers (0 USCIS approvals) and lift lca_latest_fy
const emp = [...employers.entries()];
for (let i = 0; i < emp.length; i += 200) statements.push(`INSERT OR IGNORE INTO h1b_sponsors (name_norm,name,key1,fiscal_year,approvals,state,lca_latest_fy) VALUES\n${emp.slice(i, i + 200).map(([norm, e]) => `(${q(norm)},${q(e.name)},${q(employerKey(norm))},${e.fy},0,${q(top(e.states, 1)[0] || null)},${e.fy})`).join(",\n")};`);
for (let i = 0; i < emp.length; i += 500) statements.push(`UPDATE h1b_sponsors SET lca_latest_fy=(SELECT max(fiscal_year) FROM h1b_lca_stats s WHERE s.name_norm=h1b_sponsors.name_norm) WHERE name_norm IN (${emp.slice(i, i + 500).map(([n]) => q(n)).join(",")});`);
writeFileSync("data/h1b-lca-stats.sql", statements.join("\n"));
console.error(`employer-years: ${merged.size} | employers: ${employers.size} → data/h1b-lca-stats.sql (${statements.length} statements)`);
