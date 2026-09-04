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

export type SponsorRow = { nameNorm: string; name: string; approvals: number; fiscalYear: number; state: string | null };
export type SponsorMatch = { name: string; approvals: number; fiscalYear: number; exact: boolean };

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
  const hits = candidates.filter(c => c.nameNorm === norm || c.nameNorm.startsWith(`${norm} `) || (c.nameNorm.length >= 5 && norm.startsWith(`${c.nameNorm} `)));
  if (!hits.length) return null;
  // Without an exact hit, a prefix must be unambiguous: a generic word ("first", "general", "open") fans out to many
  // unrelated employers, and a very short name ("ramp") is only trusted when it points at one or two of them.
  if (!hits.some(c => c.nameNorm === norm)) {
    const specific = norm.length >= 5 || norm.includes(" ");
    if (hits.length > (specific ? 4 : 2)) return null;
  }
  const best = hits.reduce((a, b) => (b.approvals > a.approvals ? b : a));
  return { name: best.name, approvals: hits.reduce((sum, c) => sum + c.approvals, 0), fiscalYear: Math.max(...hits.map(c => c.fiscalYear)), exact: hits.some(c => c.nameNorm === norm) };
}
