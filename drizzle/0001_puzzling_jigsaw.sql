CREATE TABLE `discovery_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`queries` integer DEFAULT 0 NOT NULL,
	`results` integer DEFAULT 0 NOT NULL,
	`new_sources` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`ats` text NOT NULL,
	`slug` text NOT NULL,
	`company_name` text NOT NULL,
	`board_url` text NOT NULL,
	`origin` text DEFAULT 'seed' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`last_validated_at` text,
	`last_scanned_at` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_job_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_boards_ats_slug_unique` ON `source_boards` (`ats`,`slug`);--> statement-breakpoint
CREATE TABLE `system_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
