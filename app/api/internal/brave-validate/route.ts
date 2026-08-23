import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { braveResults, jobs, sourceBoards } from "../../../../db/schema";
import { enabledAts, fetchBoardJobs, type CanonicalJob, type SourceBoard } from "../../../../lib/ats-connectors";
import { parseSourceUrl } from "../../../../lib/job-discovery";

function normalizeUrl(raw:string){const url=new URL(raw);url.hash="";url.search="";url.pathname=url.pathname.replace(/\/(?:application|apply)\/?$/i,"").replace(/\/+$/g,"")||"/";return url.toString().toLowerCase()}
function matchesCandidate(url:string,job:CanonicalJob){try{const haystack=decodeURIComponent(url).toLowerCase();return haystack.includes(job.externalJobId.toLowerCase())||normalizeUrl(url)===normalizeUrl(job.applyUrl)||normalizeUrl(url)===normalizeUrl(job.sourceUrl)}catch{return false}}

export async function POST(request:Request){
  const db=getDb(),body=await request.json().catch(()=>({})) as {runId?:number};
  let runId=body.runId;
  if(!runId){const latest=await db.select({runId:braveResults.discoveryRunId}).from(braveResults).orderBy(desc(braveResults.discoveryRunId)).limit(1);runId=latest[0]?.runId}
  if(!runId)return Response.json({done:true,remaining:0,processed:0,verified:0,excluded:0});

  await db.update(braveResults).set({verificationStatus:"search_result",reviewStatus:"unreviewed"}).where(and(eq(braveResults.discoveryRunId,runId),eq(braveResults.verificationStatus,"unsupported_ats"),inArray(braveResults.ats,enabledAts)));
  await db.update(braveResults).set({verificationStatus:"unsupported_ats",reviewStatus:"excluded"}).where(and(eq(braveResults.discoveryRunId,runId),eq(braveResults.verificationStatus,"search_result"),notInArray(braveResults.ats,enabledAts)));
  const freshnessPriority=sql<number>`CASE WHEN ${braveResults.postedAt} IS NOT NULL AND julianday(${braveResults.postedAt}) >= julianday('now','-7 days') THEN 0 ELSE 1 END`;
  const pending=await db.select().from(braveResults).where(and(eq(braveResults.discoveryRunId,runId),eq(braveResults.verificationStatus,"search_result"),inArray(braveResults.ats,enabledAts))).orderBy(freshnessPriority,desc(braveResults.postedAt),braveResults.id).limit(600);
  const groups=new Map<string,{source:SourceBoard;boardUrl:string;origin:string;rows:typeof pending}>();
  for(const row of pending){const parsed=parseSourceUrl(row.resultUrl,"discovery-validate");if(!parsed){await db.update(braveResults).set({verificationStatus:"invalid_url",reviewStatus:"excluded"}).where(eq(braveResults.id,row.id));continue}if(!groups.has(parsed.id)&&groups.size>=10)continue;const group=groups.get(parsed.id)??{source:{id:parsed.id,ats:parsed.ats,slug:parsed.slug,companyName:parsed.companyName},boardUrl:parsed.boardUrl,origin:parsed.origin,rows:[]};group.rows.push(row);groups.set(parsed.id,group)}
  const existing=await db.select({id:jobs.id,canonicalKey:jobs.canonicalKey}).from(jobs),jobIds=new Map(existing.map(item=>[item.canonicalKey,item.id]));
  let processed=0,verified=0,excluded=0;
  await Promise.all([...groups.values()].map(async group=>{let boardJobs:CanonicalJob[];try{boardJobs=await fetchBoardJobs(group.source)}catch{for(const row of group.rows){processed++;excluded++;await db.update(braveResults).set({verificationStatus:"validation_error",reviewStatus:"needs_review"}).where(eq(braveResults.id,row.id))}return}
    let verifiedOnBoard=false;
    for(const row of group.rows){processed++;const job=boardJobs.find(item=>matchesCandidate(row.resultUrl,item));if(!job){excluded++;await db.update(braveResults).set({verificationStatus:"expired_irrelevant_or_non_us",reviewStatus:"excluded"}).where(eq(braveResults.id,row.id));continue}
      verifiedOnBoard=true;const matchedJobId=jobIds.get(job.canonicalKey)??null,terminalReview=["dismissed","promoted"].includes(row.reviewStatus);verified++;await db.update(braveResults).set({title:job.title,company:job.company,location:job.location,resultUrl:job.applyUrl,postedAt:job.postedAt,lastSeenAt:new Date().toISOString(),verificationStatus:"verified",reviewStatus:terminalReview?row.reviewStatus:"validated",matchedJobId,isDuplicate:Boolean(matchedJobId),isTargetRole:true,usLocationStatus:"confirmed"}).where(eq(braveResults.id,row.id));
    }
    if(verifiedOnBoard){const now=new Date().toISOString();await db.insert(sourceBoards).values({id:group.source.id,ats:group.source.ats,slug:group.source.slug,companyName:group.source.companyName,boardUrl:group.boardUrl,origin:group.origin,status:"active",active:true,lastValidatedAt:now,lastError:null,consecutiveFailures:0,lastJobCount:boardJobs.length,updatedAt:now}).onConflictDoUpdate({target:sourceBoards.id,set:{companyName:group.source.companyName,boardUrl:group.boardUrl,status:"active",active:true,lastValidatedAt:now,lastError:null,consecutiveFailures:0,lastJobCount:boardJobs.length,updatedAt:now}})}
  }));
  const remaining=(await db.select({id:braveResults.id}).from(braveResults).where(and(eq(braveResults.discoveryRunId,runId),eq(braveResults.verificationStatus,"search_result"))).limit(600)).length;
  return Response.json({done:remaining===0,remaining,processed,verified,excluded});
}
