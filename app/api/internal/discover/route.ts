import { discoverNewBoards } from "../../../../lib/discovery";

/** Run Google company-board discovery now (the scheduled run does this once a day on its own). */
export async function POST() {
  try {
    const result = await discoverNewBoards();
    return Response.json(result, { status: result.configured ? 200 : 503 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Discovery failed" }, { status: 500 });
  }
}
