CREATE TABLE `brave_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`result_key` text NOT NULL,
	`discovery_run_id` integer NOT NULL,
	`ats` text NOT NULL,
	`domain` text NOT NULL,
	`query_group` text NOT NULL,
	`title` text NOT NULL,
	`company` text,
	`location` text,
	`result_url` text NOT NULL,
	`snippet` text,
	`posted_at` text,
	`discovered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`verification_status` text DEFAULT 'search_result' NOT NULL,
	`review_status` text DEFAULT 'unreviewed' NOT NULL,
	`matched_job_id` text,
	`is_duplicate` integer DEFAULT false NOT NULL,
	`is_new_company` integer DEFAULT false NOT NULL,
	`is_target_role` integer DEFAULT false NOT NULL,
	`us_location_status` text DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brave_results_result_key_unique` ON `brave_results` (`result_key`);