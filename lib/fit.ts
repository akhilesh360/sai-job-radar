import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { h1bSponsors, jobs } from "../db/schema";
import { employerKey, matchSponsor, normalizeEmployer, type SponsorRow } from "./h1b";
import { getState, setState } from "./state";
import { classifyRole, type RoleFamily } from "./roles";

/**
 * Fit scoring: how well does a job match the candidate? A small model (Workers AI, Llama 3.1 8B) reads the candidate
 * profile and a batch of jobs — title, company, location, salary, sponsorship on record — and returns 0-100 with a
 * one-line reason. Boards give us titles and locations, not full descriptions, so the score is about role, seniority,
 * location and sponsorship fit; it cannot see the stack listed inside a description.
 */

export const PROFILE_KEY = "candidate_profile";
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const BATCH = 8;

type Ai = { run(model: string, input: Record<string, unknown>): Promise<unknown> };
function ai(): Ai | null {
  const binding = (env as unknown as { AI?: Ai }).AI;
  return binding && typeof binding.run === "function" ? binding : null;
}
export function fitConfigured() { return ai() !== null; }

export const defaultProfile = `Not set yet. Open the Profile panel on the dashboard and describe yourself: target roles, seniority, skills, years of experience, locations / remote preference, visa sponsorship needs, and anything you want to avoid.`;

export async function getProfile() {
  return (await getState(getDb(), PROFILE_KEY)) ?? defaultProfile;
}
export async function saveProfile(text: string) {
  await setState(getDb(), PROFILE_KEY, text.trim().slice(0, 6000));
}

const rubric = `You score job postings for one candidate. Reply with JSON only.

Give five sub-scores per job (integers within the stated ranges); the total is computed from them.
- role (0-35): is this the kind of role the candidate targets? Same family high; adjacent (e.g. Data Scientist for a Data Engineer profile) upper-mid; unrelated (frontend, mobile, embedded, sales, support, hardware) 0-5.
- seniority (0-20): fits the candidate's level. Staff / Principal / Lead / Head of / Director / Manager / Distinguished: 0-4. Intern / co-op / new grad when the candidate is mid-senior: 0-3. Mid or Senior IC: 15-20. Entry/Associate/I: 9-13.
- skills (0-20): judged from title and company only — platform/stack words in the title, industry, company type. Unknown is 8-12, not 0.
- location (0-15): the candidate accepts any US city, remote, hybrid or onsite — every US location scores 12-15. Non-US location: 0. "US citizenship", "clearance", "ITAR" in the title: 0.
- sponsorship (0-10): 8-10 when H-1B is on record; 4-6 when none is found (many fine employers are simply absent from the public records — this must NOT lower the other sub-scores); 0 for "no sponsorship", "citizens only", clearance, or staffing-agency reposts.

reason: one sentence, at most 18 words, naming the decisive factor for THIS job.`;

/**
 * The role component (0-35) is fixed by the owner's priority order rather than left to the model: Data Engineering first,
 * then Data Science / Analytics, then AI & ML, then GTM / Forward Deployed, then data-flavoured software roles.
 * Titles the classifier cannot place keep the model's own role judgement, capped low.
 */
export const roleTiers: Record<RoleFamily, number> = {
  "Data Engineer": 35,
  "Analytics Engineer": 31,
  "Data Scientist": 30,
  "Business Intelligence": 27,
  "Data Analyst": 26,
  "ML Engineer": 29,
  "AI Engineer": 29,
  "Software Engineer, Data/ML": 25,
  "Forward Deployed / GTM Engineer": 24,
  "Solutions / Customer Engineer": 21,
  "Backend / Platform Engineer": 20,
  "Cloud / DevOps Engineer": 19,
  "Product Engineer": 14,
};
const UNCLASSIFIED_ROLE_CAP = 10;

type Parts = { n: number; role: number; seniority: number; skills: number; location: number; sponsorship: number; reason: string };
type Scored = { n: number; score: number; reason: string };
const clamp = (value: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)));

async function scoreBatch(profile: string, batch: Array<{ n: number; text: string; title: string }>): Promise<Scored[]> {
  const binding = ai(); if (!binding) throw new Error("Workers AI binding \"AI\" is not configured");
  const user = `CANDIDATE PROFILE:\n${profile}\n\nJOBS:\n${batch.map(b => `${b.n}. ${b.text}`).join("\n")}\n\nReturn {"scores":[{"n":<job number>,"role":<0-35>,"seniority":<0-20>,"skills":<0-20>,"location":<0-15>,"sponsorship":<0-10>,"reason":"<one sentence>"}, ...]} covering every job number exactly once.`;
  const part = (max: number) => ({ type: "integer", minimum: 0, maximum: max });
  const result = await binding.run(MODEL, {
    messages: [{ role: "system", content: rubric }, { role: "user", content: user }],
    max_tokens: 1200, temperature: 0.1,
    response_format: { type: "json_schema", json_schema: { type: "object", properties: { scores: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, role: part(35), seniority: part(20), skills: part(20), location: part(15), sponsorship: part(10), reason: { type: "string" } }, required: ["n", "role", "seniority", "skills", "location", "sponsorship", "reason"] } } }, required: ["scores"] } },
  });
  const raw = typeof result === "string" ? result : (result as { response?: unknown }).response;
  const parsed = typeof raw === "string" ? JSON.parse(raw.replace(/^[^{]*/, "").replace(/[^}]*$/, "")) : raw;
  const scores = (parsed as { scores?: Parts[] })?.scores;
  if (!Array.isArray(scores)) throw new Error("model returned no scores array");
  // The total is ours to compute: each component is capped, so "no sponsorship on record" can cost at most 10 points.
  const titleByN = new Map(batch.map(b => [b.n, b.title]));
  return scores.filter(s => Number.isFinite(Number(s.n))).map(s => {
    const family = classifyRole(titleByN.get(Number(s.n)) ?? "");
    const role = family ? roleTiers[family] : clamp(s.role, UNCLASSIFIED_ROLE_CAP);
    return {
      n: Number(s.n),
      score: role + clamp(s.seniority, 20) + clamp(s.skills, 20) + clamp(s.location, 15) + clamp(s.sponsorship, 10),
      reason: String(s.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
}

/** Score up to `limit` unscored open jobs, newest first. Returns counts; never throws for a single bad batch. */
export async function scorePendingJobs(limit = 80) {
  const db = getDb();
  if (!fitConfigured()) return { configured: false as const, scored: 0, failed: 0, remaining: 0 };
  const profile = await getProfile();
  const pending = await db.select().from(jobs).where(and(isNull(jobs.fitScore), inArray(jobs.status, ["New", "Saved"]))).orderBy(desc(jobs.postedAt), desc(jobs.discoveredAt)).limit(Math.min(200, Math.max(1, limit)));
  // Sponsorship on record, looked up once per distinct first token.
  const keys = [...new Set(pending.map(job => employerKey(normalizeEmployer(job.company))).filter(Boolean))];
  const byKey = new Map<string, SponsorRow[]>();
  for (let index = 0; index < keys.length; index += 90) {
    for (const row of await db.select().from(h1bSponsors).where(inArray(h1bSponsors.key1, keys.slice(index, index + 90)))) byKey.set(row.key1, [...(byKey.get(row.key1) ?? []), row]);
  }
  let scored = 0, failed = 0;
  const now = new Date().toISOString();
  for (let index = 0; index < pending.length; index += BATCH) {
    const chunk = pending.slice(index, index + BATCH);
    const batch = chunk.map((job, i) => {
      const sponsor = matchSponsor(job.company, byKey.get(employerKey(normalizeEmployer(job.company))) ?? []);
      const facts = [`"${job.title}" at ${job.company}`, `location: ${job.location || "unknown"} (${job.workplace})`, job.salary ? `salary: ${job.salary}` : "", `source: ${job.source}`,
        sponsor ? `H-1B on record: yes${sponsor.approvals ? ` (${sponsor.approvals} approvals FY${sponsor.fiscalYear})` : ""}${sponsor.lcaLatestFy ? `, LCAs FY${sponsor.lcaLatestFy}` : ""}` : "H-1B on record: none found"].filter(Boolean).join("; ");
      return { n: i + 1, text: facts, title: job.title };
    });
    try {
      const results = await scoreBatch(profile, batch);
      const byN = new Map(results.map(r => [r.n, r]));
      for (let i = 0; i < chunk.length; i++) {
        const r = byN.get(i + 1);
        if (r) { await db.update(jobs).set({ fitScore: r.score, fitReason: r.reason, fitScoredAt: now }).where(eq(jobs.id, chunk[i].id)); scored++; }
        else { await db.update(jobs).set({ fitScore: -1, fitReason: "not returned by the model", fitScoredAt: now }).where(eq(jobs.id, chunk[i].id)); failed++; }
      }
    } catch (error) {
      failed += chunk.length;
      const reason = `scoring failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`;
      await db.update(jobs).set({ fitScore: -1, fitReason: reason, fitScoredAt: now }).where(inArray(jobs.id, chunk.map(job => job.id)));
    }
  }
  const remainingRows = await db.select({ count: sql<number>`count(*)` }).from(jobs).where(and(isNull(jobs.fitScore), inArray(jobs.status, ["New", "Saved"])));
  return { configured: true as const, scored, failed, remaining: Number(remainingRows[0]?.count ?? 0) };
}

/** Clear scores so the next pass re-scores everything (after a profile change). */
export async function resetScores() {
  await getDb().update(jobs).set({ fitScore: null, fitReason: null, fitScoredAt: null }).where(inArray(jobs.status, ["New", "Saved"]));
}
