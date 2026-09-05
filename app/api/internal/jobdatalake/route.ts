import { syncJobDataLake } from "../../../../lib/jobdatalake";

/** POST {force?} → ask JobDataLake for yesterday's US data roles and queue the readable boards the catalog lacks. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { force?: boolean };
  return Response.json(await syncJobDataLake(body.force ?? true));
}
