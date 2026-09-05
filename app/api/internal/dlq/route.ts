import { deadLetterSummary, retryDeadLetter } from "../../../../lib/pipeline";

/** Dead-letter queue: GET shows what is parked and why; POST re-probes a slice of boards that are due. */
export async function GET() {
  return Response.json(await deadLetterSummary());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { limit?: number; force?: boolean };
  try {
    return Response.json(await retryDeadLetter(body.limit ?? 40, 8, body.force ?? false));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Retry failed" }, { status: 500 });
  }
}
