import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { h1bSponsors, jobs } from "../db/schema";
import { employerKey, matchSponsor, normalizeEmployer, type SponsorRow } from "./h1b";
import { getState, setState } from "./state";
import { classifyRole, type RoleFamily } from "./roles";
import { fetchJobDetails } from "./ats-connectors";
import { extractSkills, hasHardBlocker, summarizeJd } from "./jd";
import { visibleJobs } from "./visibility";

/**
 * Fit score, 0-100, fully deterministic — the owner's rules, no model:
 *   role (35) + sponsorship (10) + experience asked (10) + location (10) + seniority from the title (15) + JD tools match (20).
 * A description that says "no sponsorship" caps the total at 35. Every part is spelled out in the reason.
 */

export const PROFILE_KEY = "candidate_profile";
export function fitConfigured() { return true; }
export const defaultProfile = `Not set yet. Open the Profile panel and list your skills/tools (the tools match uses them), plus anything else about you.`;

export async function getProfile() { return (await getState(getDb(), PROFILE_KEY)) ?? defaultProfile; }
export async function saveProfile(text: string) { await setState(getDb(), PROFILE_KEY, text.trim().slice(0, 6000)); }

/** Role (0-35): the owner's priority order. Titles the classifier cannot place score 0 here. */
export const roleTiers: Record<RoleFamily, number> = {
  "Data Engineer": 35, "Analytics Engineer": 31, "Data Scientist": 30, "ML Engineer": 29, "AI Engineer": 29, "Business Intelligence": 27,
  "Data Analyst": 26, "Software Engineer, Data/ML": 25, "Forward Deployed / GTM Engineer": 24, "Solutions / Customer Engineer": 21,
  "Backend / Platform Engineer": 20, "Cloud / DevOps Engineer": 19, "Product Engineer": 14,
};

/** Experience asked (0-10): 3-6 years is the sweet spot. */
export function experiencePoints(years: number | null): [number, string] {
  if (years === null) return [5, "years not stated 5"];
  if (years <= 2) return [6, `${years}+ yrs 6`];
  if (years <= 6) return [10, `${years}+ yrs 10`];
  return [5, `${years}+ yrs 5`];
}

const dallasArea = /\b(?:dallas|irving|arlington|fort worth|ft\.? worth|richardson|plano|frisco|mckinney|addison|grapevine|denton|garland|carrollton|lewisville|coppell|southlake|allen|flower mound|dfw|dallas[-–/ ]fort worth|metroplex)\b/i;
/** Location (0-10): remote 10, Dallas–Fort Worth 8, any other US location 5, outside the US 0. */
export function locationPoints(location: string, workplace: string): [number, string] {
  const text = location || "";
  if (workplace === "Remote" || /\bremote\b/i.test(text)) return [10, "Remote 10"];
  const arlingtonElsewhere = /arlington/i.test(text) && /\b(?:va|virginia|ma|massachusetts)\b/i.test(text) && !/\b(?:tx|texas)\b/i.test(text);
  if (dallasArea.test(text) && !arlingtonElsewhere) return [8, "Dallas area 8"];
  return [5, "US 5"];
}

/** Seniority (0-15) from the title only; years are scored separately so they are not counted twice. */
export function seniorityPoints(title: string): [number, string] {
  if (/\b(?:intern(?:ship)?|co-?op|new grad(?:uate)?|graduate program|apprentice)\b/i.test(title)) return [0, "intern/new grad 0"];
  if (/\b(?:manager|director|head of|vp|vice president|chief|cto|cio|management)\b/i.test(title)) return [0, "manager 0"];
  if (/\b(?:staff|principal|distinguished|lead|architect|fellow)\b/i.test(title)) return [3, "staff/principal/lead 3"];
  if (/\b(?:entry|associate|junior|jr\.?|early career|level 1|\bi\b|\b1\b)\b/i.test(title) && !/\b(?:ii|iii|iv)\b/i.test(title)) return [10, "entry/associate 10"];
  return [15, "IC 15"];
}

/** JD tools match (0-20): share of the tools the description names that appear in the candidate's profile. */
export function toolPoints(jdSkills: string | null, candidateSkills: Set<string>): [number, string] {
  const named = (jdSkills ?? "").split(", ").map(s => s.trim()).filter(Boolean);
  if (!named.length) return [10, "no description 10"];
  const matched = named.filter(s => candidateSkills.has(s.toLowerCase()));
  const pts = Math.round((matched.length / named.length) * 20);
  return [pts, `tools ${matched.length}/${named.length} ${pts}`];
}

type ScoreInput = { title: string; location: string; workplace: string; jdSkills: string | null; jdYears: number | null; jdFlags: string | null; sponsored: boolean };
export function computeFit(job: ScoreInput, candidateSkills: Set<string>): { score: number; reason: string } {
  const family = classifyRole(job.title);
  const role = family ? roleTiers[family] : 0;
  const flags = (job.jdFlags ?? "").split(",").filter(Boolean);
  const sponsorPts = job.sponsored || flags.includes("sponsorship-offered") ? 10 : 0;
  const [exp, expWhy] = experiencePoints(job.jdYears);
  const [loc, locWhy] = locationPoints(job.location, job.workplace);
  const [sen, senWhy] = seniorityPoints(job.title);
  const [tools, toolsWhy] = toolPoints(job.jdSkills, candidateSkills);
  let score = role + sponsorPts + exp + loc + sen + tools;
  const parts = [`${family ?? "other role"} ${role}`, sponsorPts ? "sponsor on record 10" : "no sponsor record 0", expWhy, locWhy, senWhy, toolsWhy];
  if (hasHardBlocker(flags)) { score = Math.min(score, 35); parts.push("description rules out sponsorship → capped 35"); }
  return { score, reason: `${parts.join(" · ")} = ${score}` };
}

/** Score up to `limit` unscored open jobs, newest first; reads descriptions for boards that only list titles. */
export async function scorePendingJobs(limit = 80) {
  const db = getDb();
  const profile = await getProfile();
  const candidateSkills = new Set(extractSkills(profile).map(s => s.toLowerCase()));
  const pending = await db.select().from(jobs).where(and(isNull(jobs.fitScore), inArray(jobs.status, ["New", "Saved"]), visibleJobs)).orderBy(desc(jobs.postedAt), desc(jobs.discoveredAt)).limit(Math.min(200, Math.max(1, limit)));
  const keys = [...new Set(pending.map(job => employerKey(normalizeEmployer(job.company))).filter(Boolean))];
  const byKey = new Map<string, SponsorRow[]>();
  for (let index = 0; index < keys.length; index += 90) {
    for (const row of await db.select().from(h1bSponsors).where(inArray(h1bSponsors.key1, keys.slice(index, index + 90)))) byKey.set(row.key1, [...(byKey.get(row.key1) ?? []), row]);
  }
  const now = new Date().toISOString();
  let scored = 0, failed = 0;
  for (let index = 0; index < pending.length; index += 10) {
    const chunk = pending.slice(index, index + 10);
    await Promise.all(chunk.map(async job => {
      try {
        if (!job.jdFetchedAt) {
          const details = await fetchJobDetails(job);
          const jd = details.text ? summarizeJd(details.text.slice(0, 8000)) : null;
          Object.assign(job, { jdSkills: jd?.skills.join(", ") || null, jdYears: jd?.years ?? null, jdFlags: jd?.flags.join(",") || null, jdFetchedAt: now });
          // Greenhouse lists only carry updated_at; the per-job call gives the true first-published date and pay range.
          if (details.salary && !job.salary) job.salary = details.salary;
          if (details.postedAt && (!job.postedAt || details.postedAt < job.postedAt)) job.postedAt = details.postedAt;
        }
        const sponsored = matchSponsor(job.company, byKey.get(employerKey(normalizeEmployer(job.company))) ?? []) !== null;
        const { score, reason } = computeFit({ ...job, sponsored }, candidateSkills);
        await db.update(jobs).set({ fitScore: score, fitReason: reason, fitScoredAt: now, jdSkills: job.jdSkills, jdYears: job.jdYears, jdFlags: job.jdFlags, jdFetchedAt: job.jdFetchedAt, salary: job.salary, postedAt: job.postedAt }).where(eq(jobs.id, job.id));
        scored++;
      } catch (error) {
        failed++;
        await db.update(jobs).set({ fitScore: -1, fitReason: `scoring failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`, fitScoredAt: now }).where(eq(jobs.id, job.id));
      }
    }));
  }
  const remainingRows = await db.select({ count: sql<number>`count(*)` }).from(jobs).where(and(isNull(jobs.fitScore), inArray(jobs.status, ["New", "Saved"]), visibleJobs));
  return { configured: true as const, scored, failed, remaining: Number(remainingRows[0]?.count ?? 0) };
}

/** Clear scores so the next pass re-scores everything (after a profile change). */
export async function resetScores() {
  await getDb().update(jobs).set({ fitScore: null, fitReason: null, fitScoredAt: null }).where(inArray(jobs.status, ["New", "Saved"]));
}
