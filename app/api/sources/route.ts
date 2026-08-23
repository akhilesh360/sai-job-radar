import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../db";
import { sourceBoards, systemState } from "../../../db/schema";
import { defaultSources } from "../../../lib/default-sources";
import { getCatalogOffset, importSourceSeedBatch, sourceSeedCount } from "../../../lib/source-catalog";

async function ensureDefaults(){const db=getDb();for(let index=0;index<defaultSources.length;index+=7)await db.insert(sourceBoards).values(defaultSources.slice(index,index+7)).onConflictDoNothing()}

export async function GET(){
  await ensureDefaults();const db=getDb(),rows=await db.select({ats:sourceBoards.ats,status:sourceBoards.status,active:sourceBoards.active}).from(sourceBoards);const byAts:Record<string,number>={},catalogOffset=await getCatalogOffset();
  const hourlyState=await db.select({value:systemState.value}).from(systemState).where(eq(systemState.key,"last_hourly_run_at")).limit(1);
  const lastHourlyAt=hourlyState[0]?.value??null,hourlyActive=Boolean(lastHourlyAt&&Date.now()-new Date(lastHourlyAt).getTime()<2.5*60*60*1000);
  const bindings=env as unknown as {SERPER_API_KEY?:string;RESEND_API_KEY?:string;JOB_ALERT_EMAIL?:string};
  for(const row of rows)byAts[row.ats]=(byAts[row.ats]??0)+1;
  return Response.json({total:rows.length,active:rows.filter(row=>row.active).length,pending:rows.filter(row=>row.status==="pending").length,invalid:rows.filter(row=>row.status==="invalid").length,byAts,seedCatalogSize:sourceSeedCount,catalogOffset,catalogComplete:catalogOffset>=sourceSeedCount,discoveryConfigured:Boolean(bindings.SERPER_API_KEY),emailConfigured:Boolean(bindings.RESEND_API_KEY&&bindings.JOB_ALERT_EMAIL),hourlyActive,lastHourlyAt});
}

export async function POST(request:Request){
  await ensureDefaults();const body=await request.json().catch(()=>({})) as {offset?:number;limit?:number};const offset=body.offset??await getCatalogOffset();
  return Response.json(await importSourceSeedBatch(offset,body.limit??250));
}
