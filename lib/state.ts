import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { systemState } from "../db/schema";

type Db = ReturnType<typeof getDb>;

export async function setState(db: Db, key: string, value: string) {
  const at = new Date().toISOString();
  await db.insert(systemState).values({ key, value, updatedAt: at }).onConflictDoUpdate({ target: systemState.key, set: { value, updatedAt: at } });
}

export async function getState(db: Db, key: string) {
  const rows = await db.select({ value: systemState.value }).from(systemState).where(eq(systemState.key, key)).limit(1);
  return rows[0]?.value ?? null;
}
