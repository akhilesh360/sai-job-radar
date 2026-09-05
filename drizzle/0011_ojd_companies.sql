CREATE TABLE IF NOT EXISTS `ojd_companies` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ats` text NOT NULL,
	`slug` text NOT NULL,
	`career_url` text,
	`country` text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ojd_companies_ats_idx` ON `ojd_companies` (`ats`);
