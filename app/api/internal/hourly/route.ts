import { getDb } from "../../../../db";
import { systemState } from "../../../../db/schema";
import { env } from "cloudflare:workers";

export async function POST(request:Request){
  const bindings=env as unknown as {SERPER_API_KEY?:string};
  const discovery={configured:Boolean(bindings.SERPER_API_KEY),skipped:true,message:"Google discovery runs on its separate controlled schedule."};
  const sourceResponse=await fetch(new URL("/api/sources",request.url),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:250})});
  const sources=await sourceResponse.json();
  const validationBatches=[];for(let batch=0;batch<2;batch++){const validationResponse=await fetch(new URL("/api/internal/validate-sources",request.url),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:40})});validationBatches.push(await validationResponse.json() as {checked:number;active:number;invalid:number;remaining:boolean})}
  const validation={checked:validationBatches.reduce((sum,item)=>sum+item.checked,0),active:validationBatches.reduce((sum,item)=>sum+item.active,0),invalid:validationBatches.reduce((sum,item)=>sum+item.invalid,0),remaining:validationBatches.at(-1)?.remaining??false};
  const ingest=await fetch(new URL("/api/internal/ingest",request.url),{method:"POST"});
  const collection=await ingest.json();
  const digest=await fetch(new URL("/api/internal/digest",request.url),{method:"POST"});
  const email=await digest.json();
  const now=new Date().toISOString();await getDb().insert(systemState).values({key:"last_hourly_run_at",value:now,updatedAt:now}).onConflictDoUpdate({target:systemState.key,set:{value:now,updatedAt:now}});
  return Response.json({discovery,sources,validation,collection,email,discoveryConfigured:Boolean(bindings.SERPER_API_KEY),emailConfigured:digest.status!==503},{status:ingest.ok?200:502});
}
