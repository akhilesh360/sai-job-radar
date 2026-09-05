import { sendFitAlerts } from "../../../../lib/alerts";

/** POST → push not-yet-alerted jobs scoring 75+ to the owner's ntfy topic (the cron does this after every scoring pass). */
export async function POST() {
  return Response.json(await sendFitAlerts());
}
