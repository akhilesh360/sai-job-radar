import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { braveResults } from "../../../../db/schema";

export async function POST(request:Request){
  const body=await request.json().catch(()=>({})) as {id?:number;action?:"dismiss"};
  if(!body.id||body.action!=="dismiss")return Response.json({message:"A valid review action is required."},{status:400});
  const db=getDb(),rows=await db.select({id:braveResults.id,verificationStatus:braveResults.verificationStatus,reviewStatus:braveResults.reviewStatus}).from(braveResults).where(eq(braveResults.id,body.id)).limit(1),row=rows[0];
  if(!row||row.verificationStatus!=="verified")return Response.json({message:"Only validated jobs can be dismissed."},{status:400});
  if(row.reviewStatus==="promoted")return Response.json({message:"Jobs already added to the ATS Feed cannot be dismissed here."},{status:409});
  await db.update(braveResults).set({reviewStatus:"dismissed"}).where(eq(braveResults.id,row.id));
  return Response.json({dismissed:true});
}
