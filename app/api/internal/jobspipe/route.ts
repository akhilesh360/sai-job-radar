import { syncJobsPipe } from "../../../../lib/jobspipe";

/** POST {force?} → run the JobsPipe sponsor-only query now (the cron runs it about once a day). */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { force?: boolean };
  return Response.json(await syncJobsPipe(body.force ?? true));
}
