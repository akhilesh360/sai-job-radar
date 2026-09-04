import { desc } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../../db";
import { alertDeliveries, jobs } from "../../../../db/schema";
import { isUsLocation } from "../../../../lib/locations";

type EmailBindings = { RESEND_API_KEY?:string; JOB_ALERT_EMAIL?:string; JOB_ALERT_FROM?:string };
function escapeHtml(value:string){return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]??char))}

export async function POST(){
  const bindings=env as unknown as EmailBindings;
  if(!bindings.RESEND_API_KEY||!bindings.JOB_ALERT_EMAIL)return Response.json({message:"Email digest is code-ready. Add the free RESEND_API_KEY and JOB_ALERT_EMAIL settings to activate it."},{status:503});
  const db=getDb();const delivered=await db.select({jobId:alertDeliveries.jobId}).from(alertDeliveries);const sentIds=new Set(delivered.map(row=>row.jobId));
  const recent=(await db.select().from(jobs).orderBy(desc(jobs.discoveredAt)).limit(100)).filter(job=>!sentIds.has(job.id)&&!job.isSeed&&job.status==="New"&&isUsLocation(job.location)).slice(0,25);
  if(!recent.length)return Response.json({sent:0,message:"No new jobs are waiting for a digest."});
  const rows=recent.map(job=>`<tr><td style="padding:10px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtml(job.title)}</strong><br><span style="color:#64748b">${escapeHtml(job.company)} · ${escapeHtml(job.location)}</span></td><td style="padding:10px;border-bottom:1px solid #e5e7eb"><a href="${escapeHtml(job.applyUrl)}">Apply</a></td></tr>`).join("");
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{authorization:`Bearer ${bindings.RESEND_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({from:bindings.JOB_ALERT_FROM??"Sai Job Radar <onboarding@resend.dev>",to:[bindings.JOB_ALERT_EMAIL],subject:`Sai Job Radar: ${recent.length} new data jobs`,html:`<div style="font-family:Arial,sans-serif;max-width:720px;margin:auto"><h1 style="color:#132f49">New data jobs</h1><p>Fresh US roles discovered by Sai Job Radar.</p><table style="width:100%;border-collapse:collapse">${rows}</table></div>`})});
  if(!response.ok)return Response.json({message:"The email provider rejected the digest. Check the free email settings."},{status:502});
  await db.insert(alertDeliveries).values(recent.map(job=>({jobId:job.id,deliveryStatus:"sent"}))).onConflictDoNothing();
  return Response.json({sent:recent.length});
}
