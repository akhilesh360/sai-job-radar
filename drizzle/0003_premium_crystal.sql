CREATE TABLE `coverage_audit_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`audit_run_id` integer NOT NULL,
	`result_key` text NOT NULL,
	`ats` text NOT NULL,
	`domain` text NOT NULL,
	`query_group` text NOT NULL,
	`title` text NOT NULL,
	`company` text,
	`location` text,
	`result_url` text NOT NULL,
	`snippet` text,
	`search_indexed_at` text,
	`posted_at` text,
	`discovered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`verification_status` text DEFAULT 'search_result' NOT NULL,
	`matched_job_id` text,
	`is_duplicate` integer DEFAULT false NOT NULL,
	`is_new_company` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coverage_audit_run_result_unique` ON `coverage_audit_results` (`audit_run_id`,`result_key`);--> statement-breakpoint
CREATE TABLE `coverage_audit_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`window` text NOT NULL,
	`freshness` text NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`queries` integer DEFAULT 0 NOT NULL,
	`results` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL
);
