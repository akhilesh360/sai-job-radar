import { scanBoards } from "../../../../lib/pipeline";

/**
 * Scan a slice of active boards. The dashboard calls this in a loop with the same `since`
 * value until `remaining` reaches 0, so every active board gets covered in one pass.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { limit?: number; since?: string };
  try {
    return Response.json(await scanBoards({ limit: body.limit, since: body.since }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scan failed" }, { status: 500 });
  }
}
