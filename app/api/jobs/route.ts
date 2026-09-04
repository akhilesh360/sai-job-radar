import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { jobs } from "../../../db/schema";

const jobStatuses = ["New", "Saved", "Applied", "Interview", "Rejected", "Archived", "Closed"] as const;

export async function GET() {
  try {
    const db = getDb();
    // Earlier versions inserted fake placeholder jobs; make sure none linger in the feed.
    await db.delete(jobs).where(eq(jobs.isSeed, true));
    const rows = await db.select().from(jobs).orderBy(desc(jobs.postedAt), desc(jobs.discoveredAt)).limit(2000);
    return Response.json({ jobs: rows });
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
