import { scorePendingJobs } from "../../../../lib/fit";

/** Score unscored jobs against the candidate profile. The cron does this too; the dashboard calls it after a profile change. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { limit?: number };
  try {
    const result = await scorePendingJobs(body.limit ?? 80);
    return Response.json(result, { status: result.configured ? 200 : 503 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scoring failed" }, { status: 500 });
  }
}
