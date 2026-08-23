import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ingestionRuns, jobs, sourceBoards } from "../../../../db/schema";
import { enabledAts, fetchBoardJobs } from "../../../../lib/ats-connectors";
import { defaultSources } from "../../../../lib/default-sources";

export async function POST(){
  const db=getDb();for(let index=0;index<defaultSources.length;index+=7)await db.insert(sourceBoards).values(defaultSources.slice(index,index+7)).onConflictDoNothing();
  const activeSources=await db.select().from(sourceBoards).where(and(eq(sourceBoards.active,true),inArray(sourceBoards.ats,enabledAts))).orderBy(asc(sourceBoards.lastScannedAt),asc(sourceBoards.id)).limit(40);const [run]=await db.insert(ingestionRuns).values({status:"running"}).returning();let fetched=0,inserted=0,updated=0,failed=0;
  for(let index=0;index<activeSources.length;index+=5){await Promise.all(activeSources.slice(index,index+5).map(async source=>{try{
      const found=await fetchBoardJobs(source);fetched+=found.length;
      for(const job of found){const existing=await db.select({id:jobs.id}).from(jobs).where(eq(jobs.canonicalKey,job.canonicalKey)).limit(1);await db.insert(jobs).values(job).onConflictDoUpdate({target:jobs.canonicalKey,set:{title:job.title,company:job.company,location:job.location,workplace:job.workplace,sourceUrl:job.sourceUrl,applyUrl:job.applyUrl,postedAt:job.postedAt,lastSeenAt:job.lastSeenAt}});if(existing.length)updated++;else inserted++}
      await db.update(sourceBoards).set({lastScannedAt:new Date().toISOString(),lastJobCount:found.length,lastError:null,consecutiveFailures:0,status:"active",updatedAt:new Date().toISOString()}).where(eq(sourceBoards.id,source.id));
    }catch(error){failed++;const failures=source.consecutiveFailures+1;await db.update(sourceBoards).set({lastScannedAt:new Date().toISOString(),lastError:error instanceof Error?error.message:"Scan failed",consecutiveFailures:failures,status:failures>=3?"error":"active",active:failures<3,updatedAt:new Date().toISOString()}).where(eq(sourceBoards.id,source.id))}}))}
  const status=failed===activeSources.length&&activeSources.length?"failed":failed?"partial":"succeeded";await db.update(ingestionRuns).set({finishedAt:new Date().toISOString(),status,fetched,inserted,updated,failed}).where(eq(ingestionRuns.id,run.id));
  return Response.json({runId:run.id,status,fetched,inserted,updated,failed,sourcesScanned:activeSources.length,connectors:enabledAts});
}
