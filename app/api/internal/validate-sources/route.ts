import { validatePendingSources } from "../../../../lib/pipeline";

/** Validate a slice of pending catalog boards. Loop until `remaining` is 0. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { limit?: number };
  try {
    return Response.json(await validatePendingSources(body.limit ?? 30));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Validation failed" }, { status: 500 });
  }
}
