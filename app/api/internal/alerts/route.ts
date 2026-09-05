import { sendFitAlerts } from "../../../../lib/alerts";

/** POST {preview?: N} → send pending 75+ matches to Slack (the cron does this after every scoring pass); preview re-sends the N most recent as a sample without recording them. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { preview?: number };
  return Response.json(await sendFitAlerts(body.preview ?? 0));
}
