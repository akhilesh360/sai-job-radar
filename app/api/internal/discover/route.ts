import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../../db";
import { discoveryRuns, sourceBoards, systemState } from "../../../../db/schema";
import { discoveryDomains, discoveryQuery, parseSourceUrl } from "../../../../lib/job-discovery";

type SearchBindings={BRAVE_SEARCH_API_KEY?:string};
type BraveResponse={query?:{more_results_available?:boolean};web?:{results?:Array<{url?:string}>}};
async function braveSearch(key:string,domain:string,offset:number){
  const params=new URLSearchParams({q:`site:${domain} (${discoveryQuery})`,count:"20",offset:String(offset),country:"US",search_lang:"en",safesearch:"moderate"});
  const response=await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`,{headers:{accept:"application/json","x-subscription-token":key}});if(!response.ok)throw new Error(`Search ${response.status}`);return response.json() as Promise<BraveResponse>;
}

export async function POST(){
  const bindings=env as unknown as SearchBindings;if(!bindings.BRAVE_SEARCH_API_KEY)return Response.json({configured:false,message:"Add a Brave Search API key to activate top-down discovery."},{status:503});
  const db=getDb(),last=await db.select().from(systemState).where(eq(systemState.key,"last_brave_discovery_at")).limit(1);if(last[0]&&Date.now()-new Date(last[0].value).getTime()<20*60*60*1000)return Response.json({configured:true,skipped:true,message:"Daily discovery already completed."});
  const [run]=await db.insert(discoveryRuns).values({status:"running"}).returning();let queries=0,results=0,newSources=0,failed=0;const existing=new Set((await db.select({id:sourceBoards.id}).from(sourceBoards)).map(row=>row.id));
  const firstPages=await Promise.all(discoveryDomains.map(async domain=>{try{const data=await braveSearch(bindings.BRAVE_SEARCH_API_KEY!,domain,0);queries++;return{domain,data}}catch{failed++;return{domain,data:null}}}));
  const pages=[...firstPages];const secondPages=await Promise.all(firstPages.filter(page=>page.data?.query?.more_results_available).map(async page=>{try{const data=await braveSearch(bindings.BRAVE_SEARCH_API_KEY!,page.domain,1);queries++;return{domain:page.domain,data}}catch{failed++;return{domain:page.domain,data:null}}}));pages.push(...secondPages);
  const discovered=new Map<string,ReturnType<typeof parseSourceUrl>>();for(const page of pages){for(const item of page.data?.web?.results??[]){results++;if(!item.url)continue;const parsed=parseSourceUrl(item.url,"brave");if(parsed)discovered.set(parsed.id,parsed)}}
  for(const source of discovered.values()){if(!source||existing.has(source.id))continue;await db.insert(sourceBoards).values({...source,status:"pending",active:false}).onConflictDoNothing();existing.add(source.id);newSources++}
  const now=new Date().toISOString();await db.insert(systemState).values({key:"last_brave_discovery_at",value:now,updatedAt:now}).onConflictDoUpdate({target:systemState.key,set:{value:now,updatedAt:now}});const status=failed===discoveryDomains.length?"failed":failed?"partial":"succeeded";await db.update(discoveryRuns).set({finishedAt:now,status,queries,results,newSources,failed}).where(eq(discoveryRuns.id,run.id));
  return Response.json({configured:true,status,queries,results,newSources,failed});
}
