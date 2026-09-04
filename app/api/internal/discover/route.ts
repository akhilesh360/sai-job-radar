import { discoverNewBoards } from "../../../../lib/discovery";

/** Run Google company-board discovery now. This is the only trigger: the cron does not run Google on its own. */
export async function POST() {
  try {
    const result = await discoverNewBoards();
    return Response.json(result, { status: result.configured ? 200 : 503 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Discovery failed" }, { status: 500 });
  }
}
