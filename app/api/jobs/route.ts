import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { braveResults, jobs } from "../../../db/schema";
import { isUsLocation } from "../../../lib/ats-connectors";

const seedJobs = [
  { id:"seed-1",canonicalKey:"ashby-openai-data-engineer",title:"Data Engineer",company:"OpenAI",location:"San Francisco, CA",workplace:"Hybrid",source:"Ashby",sourceUrl:"https://jobs.ashbyhq.com/openai",applyUrl:"https://jobs.ashbyhq.com/openai",postedAt:"2026-08-22T22:18:00Z",discoveredAt:"2026-08-22T23:03:00Z",lastSeenAt:"2026-08-22T23:03:00Z",status:"New",isSeed:true },
  { id:"seed-2",canonicalKey:"greenhouse-anthropic-analytics-data-engineer",title:"Analytics Data Engineer",company:"Anthropic",location:"New York, NY",workplace:"Hybrid",source:"Greenhouse",sourceUrl:"https://job-boards.greenhouse.io/anthropic",applyUrl:"https://job-boards.greenhouse.io/anthropic",postedAt:"2026-08-22T19:40:00Z",discoveredAt:"2026-08-22T20:06:00Z",lastSeenAt:"2026-08-22T20:06:00Z",status:"New",isSeed:true },
  { id:"seed-3",canonicalKey:"ashby-vanta-senior-data-engineer",title:"Senior Data Engineer",company:"Vanta",location:"United States",workplace:"Remote",source:"Ashby",sourceUrl:"https://jobs.ashbyhq.com/vanta",applyUrl:"https://jobs.ashbyhq.com/vanta",postedAt:"2026-08-22T15:20:00Z",discoveredAt:"2026-08-22T16:01:00Z",lastSeenAt:"2026-08-22T16:01:00Z",status:"Saved",isSeed:true },
  { id:"seed-4",canonicalKey:"lever-redwood-cloud-data-engineer",title:"Cloud Data Engineer",company:"Redwood Credit Union",location:"Santa Rosa, CA",workplace:"Hybrid",source:"Lever",sourceUrl:"https://jobs.lever.co/redwoodcu",applyUrl:"https://jobs.lever.co/redwoodcu",postedAt:"2026-08-21T18:00:00Z",discoveredAt:"2026-08-21T18:44:00Z",lastSeenAt:"2026-08-21T18:44:00Z",status:"Applied",isSeed:true },
  { id:"seed-5",canonicalKey:"rippling-easy-dynamics-data-platform",title:"Data Platform Engineer",company:"Easy Dynamics",location:"McLean, VA",workplace:"Remote",source:"Rippling",sourceUrl:"https://ats.rippling.com",applyUrl:"https://ats.rippling.com",postedAt:null,discoveredAt:"2026-08-21T13:12:00Z",lastSeenAt:"2026-08-21T13:12:00Z",status:"New",isSeed:true },
  { id:"seed-6",canonicalKey:"jazzhr-nps-prism-data-engineer-ii",title:"Data Engineer II",company:"NPS Prism",location:"Boston, MA",workplace:"Hybrid",source:"JazzHR",sourceUrl:"https://applytojob.com",applyUrl:"https://applytojob.com",postedAt:"2026-08-20T14:30:00Z",discoveredAt:"2026-08-20T15:09:00Z",lastSeenAt:"2026-08-20T15:09:00Z",status:"Interview",isSeed:true },
];

async function ensureSeeded() {
  const db = getDb();
  await db.insert(jobs).values(seedJobs).onConflictDoNothing();
}

export async function GET() {
  try {
    await ensureSeeded();
    const db=getDb(),[rows,promoted]=await Promise.all([
      db.select().from(jobs).orderBy(desc(jobs.postedAt),desc(jobs.discoveredAt)).limit(500),
      db.select({jobId:braveResults.matchedJobId}).from(braveResults).where(eq(braveResults.reviewStatus,"promoted")),
    ]),promotedIds=new Set(promoted.flatMap(item=>item.jobId?[item.jobId]:[]));
    return Response.json({ jobs: rows.filter(job=>isUsLocation(job.location)).map(job=>({...job,addedFromBrave:promotedIds.has(job.id)})), mode: "persistent" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load jobs" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = await request.json() as { id?:string; status?:string };
    const allowed = ["New","Saved","Applied","Interview","Rejected","Archived"];
    if (!payload.id || !payload.status || !allowed.includes(payload.status)) return Response.json({ error:"Valid id and status are required" }, { status:400 });
    const [job] = await getDb().update(jobs).set({ status:payload.status }).where(eq(jobs.id,payload.id)).returning();
    return job ? Response.json({ job }) : Response.json({ error:"Job not found" }, { status:404 });
  } catch (error) {
    return Response.json({ error:error instanceof Error?error.message:"Unable to update status" }, { status:500 });
  }
}
