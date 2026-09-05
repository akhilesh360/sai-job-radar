import { syncOpenJobData } from "../../../../lib/openjobdata";

/** POST {force?} → run the openjobdata.com daily-delta sync now (the cron runs it every 6 hours). */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { force?: boolean };
  return Response.json(await syncOpenJobData(body.force ?? true));
}
