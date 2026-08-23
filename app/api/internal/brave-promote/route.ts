import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { braveResults, jobs } from "../../../../db/schema";
import { fetchBoardJobs, type CanonicalJob } from "../../../../lib/ats-connectors";
import { parseSourceUrl } from "../../../../lib/job-discovery";

function normalizeUrl(raw:string){const url=new URL(raw);url.hash="";url.search="";url.pathname=url.pathname.replace(/\/(?:application|apply)\/?$/i,"").replace(/\/+$/g,"")||"/";return url.toString().toLowerCase()}
function matchesCandidate(url:string,job:CanonicalJob){try{const haystack=decodeURIComponent(url).toLowerCase();return haystack.includes(job.externalJobId.toLowerCase())||normalizeUrl(url)===normalizeUrl(job.applyUrl)||normalizeUrl(url)===normalizeUrl(job.sourceUrl)}catch{return false}}

export async function POST(request:Request){
  const body=await request.json().catch(()=>({})) as {id?:number};if(!body.id)return Response.json({message:"A discovery result is required."},{status:400});
  const db=getDb(),found=await db.select().from(braveResults).where(eq(braveResults.id,body.id)).limit(1),result=found[0];
  if(!result||result.verificationStatus!=="verified")return Response.json({message:"Only validated discovery jobs can be added."},{status:400});
  const parsed=parseSourceUrl(result.resultUrl,"brave-promote")??parseSourceUrl(result.resultKey,"brave-promote-original");if(!parsed)return Response.json({message:"The ATS job source could not be resolved."},{status:400});
  let boardJobs:CanonicalJob[];try{boardJobs=await fetchBoardJobs({id:parsed.id,ats:parsed.ats,slug:parsed.slug,companyName:result.company??parsed.companyName})}catch{return Response.json({message:"The ATS board is temporarily unavailable."},{status:503})}
  const job=boardJobs.find(item=>matchesCandidate(result.resultUrl,item));if(!job)return Response.json({message:"The job is no longer active or eligible."},{status:409});
  const existing=await db.select({id:jobs.id}).from(jobs).where(eq(jobs.canonicalKey,job.canonicalKey)).limit(1);
  await db.insert(jobs).values(job).onConflictDoUpdate({target:jobs.canonicalKey,set:{title:job.title,company:job.company,location:job.location,workplace:job.workplace,sourceUrl:job.sourceUrl,applyUrl:job.applyUrl,postedAt:job.postedAt,lastSeenAt:job.lastSeenAt}});
  await db.update(braveResults).set({matchedJobId:job.id,isDuplicate:true,reviewStatus:"promoted"}).where(eq(braveResults.id,result.id));
  return Response.json({added:existing.length===0,jobId:job.id});
}
