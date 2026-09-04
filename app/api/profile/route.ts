import { fitConfigured, getProfile, resetScores, saveProfile } from "../../../lib/fit";

export async function GET() {
  return Response.json({ profile: await getProfile(), configured: fitConfigured() });
}

/** Save the profile; existing scores are cleared so the next scoring pass reflects the new profile. */
export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({})) as { profile?: string };
  if (typeof body.profile !== "string" || body.profile.trim().length < 20) return Response.json({ error: "Profile must be at least 20 characters" }, { status: 400 });
  await saveProfile(body.profile);
  await resetScores();
  return Response.json({ profile: await getProfile(), configured: fitConfigured() });
}
