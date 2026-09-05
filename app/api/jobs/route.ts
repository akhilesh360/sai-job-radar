import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { h1bSponsors, jobs } from "../../../db/schema";
import { employerKey, matchSponsor, normalizeEmployer, type SponsorRow } from "../../../lib/h1b";
import { visibleJobs } from "../../../lib/visibility";

const jobStatuses = ["New", "Saved", "Applied", "Interview", "Rejected", "Archived", "Closed"] as const;

export async function GET() {
  try {
    const db = getDb();
    // Earlier versions inserted fake placeholder jobs; make sure none linger in the feed.
    await db.delete(jobs).where(eq(jobs.isSeed, true));
    const rows = await db.select().from(jobs).where(visibleJobs).orderBy(desc(jobs.postedAt), desc(jobs.discoveredAt)).limit(2000);
    // H-1B sponsorship: look up every distinct first token once, then match each company against its candidates.
    const keys = [...new Set(rows.map(row => employerKey(normalizeEmployer(row.company))).filter(Boolean))];
    const byKey = new Map<string, SponsorRow[]>();
    for (let index = 0; index < keys.length; index += 90) {
      const found = await db.select().from(h1bSponsors).where(inArray(h1bSponsors.key1, keys.slice(index, index + 90)));
      for (const row of found) byKey.set(row.key1, [...(byKey.get(row.key1) ?? []), row]);
    }
    const withSponsor = rows.map(row => ({ ...row, h1b: matchSponsor(row.company, byKey.get(employerKey(normalizeEmployer(row.company))) ?? []) }));
    return Response.json({ jobs: withSponsor });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load jobs" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = await request.json() as { id?: string; status?: string };
    if (!payload.id || !payload.status || !(jobStatuses as readonly string[]).includes(payload.status)) return Response.json({ error: "Valid id and status are required" }, { status: 400 });
    const [job] = await getDb().update(jobs).set({ status: payload.status }).where(eq(jobs.id, payload.id)).returning();
    return job ? Response.json({ job }) : Response.json({ error: "Job not found" }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to update status" }, { status: 500 });
  }
}
