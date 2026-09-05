import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull(),
  title: text("title").notNull(),
  company: text("company").notNull(),
  location: text("location").notNull(),
  workplace: text("workplace").notNull().default("Unknown"),
  source: text("source").notNull(),
  externalJobId: text("external_job_id"),
  sourceUrl: text("source_url").notNull(),
  applyUrl: text("apply_url").notNull(),
  salary: text("salary"),
  /** 0-100 relevance to the candidate profile (lib/fit.ts); -1 when scoring failed; null when not scored yet. */
  fitScore: integer("fit_score"),
  fitReason: text("fit_reason"),
  fitScoredAt: text("fit_scored_at"),
  /** From the job description (lib/jd.ts): named tools, minimum years asked for, hard-blocker flags; when we last looked. */
  jdSkills: text("jd_skills"),
  jdYears: integer("jd_years"),
  jdFlags: text("jd_flags"),
  jdFetchedAt: text("jd_fetched_at"),
  postedAt: text("posted_at"),
  discoveredAt: text("discovered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  status: text("status").notNull().default("New"),
  isSeed: integer("is_seed", { mode: "boolean" }).notNull().default(false),
}, (table) => [uniqueIndex("jobs_canonical_key_unique").on(table.canonicalKey)]);

export const ingestionRuns = sqliteTable("ingestion_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
  status: text("status").notNull().default("running"),
  fetched: integer("fetched").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  failed: integer("failed").notNull().default(0),
});

export const alertDeliveries = sqliteTable("alert_deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull(),
  channel: text("channel").notNull().default("email"),
  sentAt: text("sent_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  deliveryStatus: text("delivery_status").notNull(),
}, (table) => [uniqueIndex("alert_job_channel_unique").on(table.jobId, table.channel)]);

export const sourceBoards = sqliteTable("source_boards", {
  id: text("id").primaryKey(),
  ats: text("ats").notNull(),
  slug: text("slug").notNull(),
  companyName: text("company_name").notNull(),
  boardUrl: text("board_url").notNull(),
  origin: text("origin").notNull().default("seed"),
  status: text("status").notNull().default("pending"),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  lastValidatedAt: text("last_validated_at"),
  lastScannedAt: text("last_scanned_at"),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastJobCount: integer("last_job_count").notNull().default(0),
  // Dead-letter fields: why the board last failed, how many attempts so far, when to try again, or when we gave up.
  failureKind: text("failure_kind"),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: text("next_retry_at"),
  deadAt: text("dead_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("source_boards_ats_slug_unique").on(table.ats, table.slug)]);

export const discoveryRuns = sqliteTable("discovery_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
  status: text("status").notNull().default("running"),
  queries: integer("queries").notNull().default(0),
  results: integer("results").notNull().default(0),
  newSources: integer("new_sources").notNull().default(0),
  failed: integer("failed").notNull().default(0),
});

export const braveResults = sqliteTable("brave_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  resultKey: text("result_key").notNull(),
  discoveryRunId: integer("discovery_run_id").notNull(),
  ats: text("ats").notNull(),
  domain: text("domain").notNull(),
  queryGroup: text("query_group").notNull(),
  title: text("title").notNull(),
  company: text("company"),
  location: text("location"),
  resultUrl: text("result_url").notNull(),
  snippet: text("snippet"),
  postedAt: text("posted_at"),
  discoveredAt: text("discovered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  verificationStatus: text("verification_status").notNull().default("search_result"),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  matchedJobId: text("matched_job_id"),
  isDuplicate: integer("is_duplicate", { mode: "boolean" }).notNull().default(false),
  isNewCompany: integer("is_new_company", { mode: "boolean" }).notNull().default(false),
  isTargetRole: integer("is_target_role", { mode: "boolean" }).notNull().default(false),
  usLocationStatus: text("us_location_status").notNull().default("unknown"),
}, (table) => [uniqueIndex("brave_results_result_key_unique").on(table.resultKey)]);

export const coverageAuditRuns = sqliteTable("coverage_audit_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  window: text("window").notNull(),
  freshness: text("freshness").notNull(),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
  status: text("status").notNull().default("running"),
  queries: integer("queries").notNull().default(0),
  results: integer("results").notNull().default(0),
  failed: integer("failed").notNull().default(0),
});

export const coverageAuditResults = sqliteTable("coverage_audit_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  auditRunId: integer("audit_run_id").notNull(),
  resultKey: text("result_key").notNull(),
  ats: text("ats").notNull(),
  domain: text("domain").notNull(),
  queryGroup: text("query_group").notNull(),
  title: text("title").notNull(),
  company: text("company"),
  location: text("location"),
  resultUrl: text("result_url").notNull(),
  snippet: text("snippet"),
  searchIndexedAt: text("search_indexed_at"),
  postedAt: text("posted_at"),
  discoveredAt: text("discovered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  verificationStatus: text("verification_status").notNull().default("search_result"),
  matchedJobId: text("matched_job_id"),
  isDuplicate: integer("is_duplicate", { mode: "boolean" }).notNull().default(false),
  isNewCompany: integer("is_new_company", { mode: "boolean" }).notNull().default(false),
}, (table) => [uniqueIndex("coverage_audit_run_result_unique").on(table.auditRunId, table.resultKey)]);

export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Employers that petitioned for H-1B workers (USCIS Employer Data Hub), aggregated by normalized name. */
export const h1bSponsors = sqliteTable("h1b_sponsors", {
  nameNorm: text("name_norm").primaryKey(),
  name: text("name").notNull(),
  key1: text("key1").notNull(),
  fiscalYear: integer("fiscal_year").notNull(),
  approvals: integer("approvals").notNull(),
  state: text("state"),
  /** Latest fiscal year with a certified H-1B LCA (DOL disclosure data), when known. */
  lcaLatestFy: integer("lca_latest_fy"),
}, (table) => [index("h1b_sponsors_key1_idx").on(table.key1)]);

/** Certified H-1B Labor Condition Applications per employer per fiscal year (DOL disclosure data, scripts/load-lca-stats.mjs). */
export const h1bLcaStats = sqliteTable("h1b_lca_stats", {
  nameNorm: text("name_norm").notNull(),
  fiscalYear: integer("fiscal_year").notNull(),
  lcas: integer("lcas").notNull(),
  positions: integer("positions").notNull(),
  dataLcas: integer("data_lcas").notNull(),
  dataWageP25: integer("data_wage_p25"),
  dataWageMedian: integer("data_wage_median"),
  dataWageP75: integer("data_wage_p75"),
  topStates: text("top_states"),
  topDataTitles: text("top_data_titles"),
}, (table) => [primaryKey({ columns: [table.nameNorm, table.fiscalYear] })]);

/** openjobdata.com company registry (company_id → name/ATS/slug), loaded by scripts/openjobdata-companies.py; joined by the daily delta sync. */
export const ojdCompanies = sqliteTable("ojd_companies", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  ats: text("ats").notNull(),
  slug: text("slug").notNull(),
  careerUrl: text("career_url"),
  country: text("country"),
}, (table) => [index("ojd_companies_ats_idx").on(table.ats)]);
