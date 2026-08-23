import { desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../../db";
import { braveResults, discoveryRuns, jobs, sourceBoards, systemState } from "../../../../db/schema";
import { enabledAts } from "../../../../lib/ats-connectors";
import { discoveryDomains, matchesTargetRole, parseSourceUrl } from "../../../../lib/job-discovery";

type SearchBindings={BRAVE_SEARCH_API_KEY?:string};
type BraveItem={title?:string;url?:string;description?:string;page_age?:string;age?:string};
type BraveResponse={web?:{results?:BraveItem[]}};

const queryGroups={
  data_analytics:'"data" OR "analytics"',
  ai_engineering:'"AI" OR "machine learning" OR "ML" OR "GTM" OR "forward deployed" OR "product engineer" OR "cloud engineer" OR "AWS engineer" OR "GCP engineer"',
} as const;

const atsByDomain:Record<string,string>={
  "jobs.ashbyhq.com":"Ashby","job-boards.greenhouse.io":"Greenhouse","jobs.lever.co":"Lever",
  "ats.rippling.com":"Rippling","apply.workable.com":"Workable","jobs.smartrecruiters.com":"SmartRecruiters",
  "myworkdayjobs.com":"Workday","jobs.jobvite.com":"Jobvite","applytojob.com":"JazzHR",
  "recruitee.com":"Recruitee","breezy.hr":"Breezy","comeet.com/jobs":"Comeet",
  "pinpointhq.com":"Pinpoint","icims.com/jobs":"iCIMS","careers-page.com":"CareerPage",
};

function normalizeUrl(raw:string){
  const url=new URL(raw);url.hash="";for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key))url.searchParams.delete(key);
  url.hostname=url.hostname.toLowerCase();url.pathname=url.pathname.replace(/\/+$/g,"")||"/";return url.toString();
}

function likelyUs(text:string){
  return /\b(United States|U\.S\.|USA|US Remote|Remote[, /-]+US|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia|Washington,? DC)\b/i.test(text);
}

async function search(key:string,domain:string,query:string){
  const params=new URLSearchParams({q:`site:${domain} (${query})`,count:"20",offset:"0",country:"US",search_lang:"en",ui_lang:"en-US",safesearch:"moderate",operators:"true",text_decorations:"false",result_filter:"web"});
  const response=await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`,{headers:{accept:"application/json","x-subscription-token":key}});
  if(!response.ok)throw new Error(`Brave Search ${response.status}`);return response.json() as Promise<BraveResponse>;
}

export async function GET(){
  const db=getDb();
  const latestResult=await db.select({runId:braveResults.discoveryRunId}).from(braveResults).orderBy(desc(braveResults.discoveryRunId)).limit(1);
  if(!latestResult[0])return Response.json({hasRun:false,metrics:null,results:[]});
  const latest=await db.select().from(discoveryRuns).where(eq(discoveryRuns.id,latestResult[0].runId)).limit(1),run=latest[0];
  if(!run)return Response.json({hasRun:false,metrics:null,results:[]});
  const candidates=await db.select().from(braveResults).where(eq(braveResults.discoveryRunId,run.id)).orderBy(desc(braveResults.lastSeenAt)).limit(600);
  const results=candidates.filter(item=>item.verificationStatus==="verified");
  const unsupported=candidates.filter(item=>item.verificationStatus==="unsupported_ats"),unsupportedCounts=new Map<string,number>();for(const item of unsupported)unsupportedCounts.set(item.ats,(unsupportedCounts.get(item.ats)??0)+1);
  const unsupportedBreakdown=[...unsupportedCounts].map(([ats,count])=>({ats,count})).sort((a,b)=>b.count-a.count||a.ats.localeCompare(b.ats));
  const newCompanies=new Set(results.filter(item=>item.isNewCompany).map(item=>`${item.ats}:${item.company??item.domain}`)).size;
  return Response.json({
    hasRun:true,
    metrics:{
      status:run.status,
      runId:run.id,
      startedAt:run.startedAt,
      finishedAt:run.finishedAt,
      requestsAttempted:run.queries,
      failed:run.failed,
      rawResults:run.results,
      uniqueResults:results.length,
      candidateResults:candidates.length,
      validationRemaining:candidates.filter(item=>item.verificationStatus==="search_result").length,
      excludedResults:candidates.filter(item=>item.verificationStatus!=="verified"&&item.verificationStatus!=="search_result").length,
      targetRoleResults:results.length,
      confirmedUsResults:results.length,
      duplicates:results.filter(item=>item.isDuplicate).length,
      newCompanies,
      unsupportedAtsResults:unsupported.length,
      unsupportedBreakdown,
    },
    results,
  });
}

export async function POST(){
  const bindings=env as unknown as SearchBindings;if(!bindings.BRAVE_SEARCH_API_KEY)return Response.json({configured:false,message:"Brave Search is not configured."},{status:503});
  const db=getDb(),last=await db.select().from(systemState).where(eq(systemState.key,"last_brave_test_at")).limit(1);
  if(last[0]&&Date.now()-new Date(last[0].value).getTime()<20*60*60*1000)return Response.json({configured:true,skipped:true,message:"The protected Brave test has already run today."});

  const [run]=await db.insert(discoveryRuns).values({status:"running"}).returning();
  const plans=discoveryDomains.flatMap(domain=>Object.entries(queryGroups).map(([queryGroup,query])=>({domain,queryGroup,query})));
  let attempted=0,failed=0;const pages:Array<{domain:string;queryGroup:string;data:BraveResponse}>=[];
  for(let index=0;index<plans.length;index+=5){
    const batch=await Promise.all(plans.slice(index,index+5).map(async plan=>{attempted++;try{return{...plan,data:await search(bindings.BRAVE_SEARCH_API_KEY!,plan.domain,plan.query)}}catch{return{...plan,data:null}}}));
    for(const item of batch){if(item.data)pages.push({domain:item.domain,queryGroup:item.queryGroup,data:item.data});else failed++}
  }

  const existingJobs=await db.select({id:jobs.id,applyUrl:jobs.applyUrl,sourceUrl:jobs.sourceUrl}).from(jobs);
  const jobByUrl=new Map<string,string>();for(const job of existingJobs){for(const raw of [job.applyUrl,job.sourceUrl])try{jobByUrl.set(normalizeUrl(raw),job.id)}catch{}}
  const existingSourceIds=new Set((await db.select({id:sourceBoards.id}).from(sourceBoards)).map(row=>row.id));
  const existingResultKeys=new Set((await db.select({resultKey:braveResults.resultKey}).from(braveResults)).map(row=>row.resultKey));

  const unique=new Map<string,{domain:string;queryGroup:string;item:BraveItem;normalizedUrl:string}>();let rawResults=0;
  for(const page of pages){for(const item of page.data.web?.results??[]){rawResults++;if(!item.url||!item.title)continue;try{const normalizedUrl=normalizeUrl(item.url),key=normalizedUrl.toLowerCase();if(!unique.has(key))unique.set(key,{domain:page.domain,queryGroup:page.queryGroup,item,normalizedUrl})}catch{}}}

  let inserted=0,refreshed=0,duplicates=0,targetRoleResults=0,confirmedUsResults=0,unsupportedAtsResults=0;const newCompanyIds=new Set<string>();const now=new Date().toISOString();
  for(const [resultKey,result] of unique){
    const parsed=parseSourceUrl(result.normalizedUrl,"brave-test"),ats=parsed?.ats??atsByDomain[result.domain]??"Unknown",title=result.item.title.trim(),snippet=result.item.description?.trim()??null;
    const matchedJobId=jobByUrl.get(result.normalizedUrl)??null,isDuplicate=Boolean(matchedJobId),isTargetRole=matchesTargetRole(title),usLocationStatus=likelyUs(`${title} ${snippet??""}`)?"confirmed":"unknown",isNewCompany=Boolean(parsed&&!existingSourceIds.has(parsed.id));
    if(isDuplicate)duplicates++;if(isTargetRole)targetRoleResults++;if(usLocationStatus==="confirmed")confirmedUsResults++;if(!enabledAts.includes(ats))unsupportedAtsResults++;if(isNewCompany&&parsed)newCompanyIds.add(parsed.id);
    const values={resultKey,discoveryRunId:run.id,ats,domain:result.domain,queryGroup:result.queryGroup,title,company:parsed?.companyName??null,location:null,resultUrl:result.normalizedUrl,snippet,postedAt:result.item.page_age??result.item.age??null,lastSeenAt:now,verificationStatus:"search_result",reviewStatus:"unreviewed",matchedJobId,isDuplicate,isNewCompany,isTargetRole,usLocationStatus};
    await db.insert(braveResults).values(values).onConflictDoUpdate({target:braveResults.resultKey,set:{discoveryRunId:run.id,ats,domain:result.domain,queryGroup:result.queryGroup,title,company:values.company,location:null,resultUrl:result.normalizedUrl,snippet,postedAt:values.postedAt,lastSeenAt:now,verificationStatus:"search_result",reviewStatus:"unreviewed",matchedJobId,isDuplicate,isNewCompany,isTargetRole,usLocationStatus}});
    if(existingResultKeys.has(resultKey))refreshed++;else{existingResultKeys.add(resultKey);inserted++}
  }

  const status=failed===plans.length?"failed":failed?"partial":"succeeded";
  await db.update(discoveryRuns).set({finishedAt:now,status,queries:attempted,results:rawResults,newSources:newCompanyIds.size,failed}).where(eq(discoveryRuns.id,run.id));
  if(status!=="failed")await db.insert(systemState).values({key:"last_brave_test_at",value:now,updatedAt:now}).onConflictDoUpdate({target:systemState.key,set:{value:now,updatedAt:now}});
  return Response.json({configured:true,status,runId:run.id,requestsPlanned:plans.length,requestsAttempted:attempted,failed,rawResults,uniqueResults:unique.size,inserted,refreshed,targetRoleResults,confirmedUsResults,duplicates,newCompanies:newCompanyIds.size,unsupportedAtsResults});
}
