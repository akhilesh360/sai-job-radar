import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { sourceBoards } from "../../../../db/schema";
import { enabledAts, fetchBoardJobs } from "../../../../lib/ats-connectors";

export async function POST(request:Request){
  const body=await request.json().catch(()=>({})) as {limit?:number};const limit=Math.min(45,Math.max(1,body.limit??40)),db=getDb();
  const originPriority=sql`CASE ${sourceBoards.origin} WHEN 'uploaded-lists' THEN 0 WHEN 'spreadsheet-current' THEN 1 WHEN 'spreadsheet-trial' THEN 2 WHEN 'historical-retry' THEN 3 ELSE 4 END`;
  const pending=await db.select().from(sourceBoards).where(and(eq(sourceBoards.status,"pending"),inArray(sourceBoards.ats,enabledAts))).orderBy(asc(originPriority),asc(sourceBoards.id)).limit(limit);let active=0,invalid=0;
  for(let index=0;index<pending.length;index+=5){await Promise.all(pending.slice(index,index+5).map(async source=>{try{const found=await fetchBoardJobs(source);await db.update(sourceBoards).set({status:"active",active:true,lastValidatedAt:new Date().toISOString(),lastError:null,consecutiveFailures:0,lastJobCount:found.length,updatedAt:new Date().toISOString()}).where(eq(sourceBoards.id,source.id));active++}catch(error){await db.update(sourceBoards).set({status:"invalid",active:false,lastValidatedAt:new Date().toISOString(),lastError:error instanceof Error?error.message:"Validation failed",consecutiveFailures:1,updatedAt:new Date().toISOString()}).where(eq(sourceBoards.id,source.id));invalid++}}))}
  return Response.json({checked:pending.length,active,invalid,remaining:pending.length===limit});
}
