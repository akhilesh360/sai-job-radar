import { and, isNull, notLike, or, sql } from "drizzle-orm";
import { jobs } from "../db/schema";
import { EXCLUDED_JD_FLAG_LIKES, EXCLUDED_TITLE_LIKES } from "./jd";

/**
 * Jobs that require US citizenship or a security clearance are never shown or scored — the owner cannot take them.
 * Matched on the description flags (lib/jd.ts) and, for boards without descriptions, on the title.
 */
export const visibleJobs = and(
  or(isNull(jobs.jdFlags), and(...EXCLUDED_JD_FLAG_LIKES.map(pattern => notLike(jobs.jdFlags, pattern)))),
  and(...EXCLUDED_TITLE_LIKES.map(pattern => sql`${jobs.title} NOT LIKE ${pattern} COLLATE NOCASE`)),
);
