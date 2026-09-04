import { runScheduledMaintenance } from "../../../../lib/scheduled";

/**
 * Same work the Worker cron does, callable by hand (or by an external scheduler such as
 * cron-job.org hitting this URL) when the hosting platform does not run cron triggers.
 */
export async function POST() {
  try {
    return Response.json(await runScheduledMaintenance());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scheduled run failed" }, { status: 500 });
  }
}
