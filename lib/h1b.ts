/**
 * H-1B sponsorship lookup. Data: USCIS H-1B Employer Data Hub yearly exports (one row per employer × office/NAICS,
 * with initial and continuing approval counts). scripts/load-h1b-sponsors.mjs aggregates them into the h1b_sponsors
 * table; the jobs API matches each job's company name against it at read time.
 */

const suffixes = new Set(["inc", "incorporated", "llc", "l", "c", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "lp", "llp", "pbc", "pc", "the"]);

/** "Amazon.com Services LLC" → "amazon com services"; "OpenAI OpCo, LLC" → "openai opco". */
export function normalizeEmployer(name: string): string {
  const tokens = name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && suffixes.has(tokens[tokens.length - 1])) tokens.pop();
  while (tokens.length > 1 && tokens[0] === "the") tokens.shift();
  return tokens.join(" ");
}

/** First significant token — the index the lookup is keyed on. */
export function employerKey(normalized: string): string {
  return normalized.split(" ")[0] ?? "";
}

const filler = new Set(["inc", "llc", "corp", "co", "company", "group", "holdings", "holding", "technologies", "technology", "tech", "labs", "lab", "software", "systems", "solutions", "services", "service", "america", "americas", "north", "us", "usa", "u", "s", "international", "global", "opco", "operations", "capital", "management", "business", "com", "io", "health", "healthcare", "financial", "finance", "partners", "ventures", "enterprises", "industries", "digital", "data", "consulting", "networks", "network", "payments", "bank", "national", "association", "n", "a", "trust", "insurance", "media", "labs", "research", "energy", "motor", "motors", "foods", "stores", "worldwide", "platforms", "products", "web", "cloud", "online", "mobile"]);

export type SponsorRow = { nameNorm: string; name: string; approvals: number; fiscalYear: number; state: string | null; lcaLatestFy?: number | null };
export type SponsorMatch = { name: string; approvals: number; fiscalYear: number; exact: boolean; lcaLatestFy: number | null };

/**
 * Pick the sponsor that a job's company name refers to, from the rows sharing its first token.
 * Exact normalized match wins; otherwise a legal name that begins with the company name ("openai" → "openai opco"),
 * or vice versa, as long as the company name is specific enough to trust. Approvals of every matching legal entity
 * are summed, since large employers file under several (Amazon.com Services, Amazon Web Services, Amazon Data Services…).
 */
export function matchSponsor(company: string, candidates: SponsorRow[]): SponsorMatch | null {
  const norm = normalizeEmployer(company);
  if (norm.length < 3) return null;
  // Every legal entity the name refers to counts: "OpenAI" → OPENAI LP + OPENAI OPCO LLC; "Amazon" → Amazon.com Services,
  // Amazon Web Services, Amazon Data Services… A candidate that is a prefix of the company name also counts when it is
  // specific enough on its own ("meta platforms" for "Meta Platforms Technologies").
  // A legal name may extend the company name only with corporate filler ("openai opco", "oracle america",
  // "voleon capital management"); anything else ("thorn hill", "scribe opco dba koozie group") is a different company.
  const extendsWithFiller = (legal: string) => legal.startsWith(`${norm} `) && legal.slice(norm.length + 1).split(" ").every(token => filler.has(token));
  // The reverse — the company name extends the legal name ("Ntt Data Aivista" → "ntt data") — needs a legal name that
  // is itself specific: at least two words or eight characters, so a surname like "allen" cannot claim it.
  const isSpecificPrefixOf = (legal: string) => norm.startsWith(`${legal} `) && (legal.includes(" ") || legal.length >= 8);
  const hits = candidates.filter(c => c.nameNorm === norm || extendsWithFiller(c.nameNorm) || isSpecificPrefixOf(c.nameNorm));
  if (!hits.length) return null;
  if (!hits.some(c => c.nameNorm === norm)) {
    if (hits.length > 3) return null;
    // A generic single word ("open", "first") prefixes many employers of which the filler-suffixed ones are a small
    // share; a real company ("amazon", "meta") dominates the group that shares its first token.
    if (!norm.includes(" ") && candidates.length >= 3) {
      const total = candidates.reduce((sum, c) => sum + c.approvals, 0);
      if (total > 0 && hits.reduce((sum, c) => sum + c.approvals, 0) / total < 0.6) return null;
    }
  }
  const best = hits.reduce((a, b) => (b.approvals > a.approvals ? b : a));
  const lcaYears = hits.map(c => c.lcaLatestFy ?? 0).filter(Boolean);
  return { name: best.name, approvals: hits.reduce((sum, c) => sum + c.approvals, 0), fiscalYear: Math.max(...hits.map(c => c.fiscalYear)), exact: hits.some(c => c.nameNorm === norm), lcaLatestFy: lcaYears.length ? Math.max(...lcaYears) : null };
}
