CREATE TABLE `h1b_sponsors` (
	`name_norm` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key1` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`approvals` integer NOT NULL,
	`state` text
);--> statement-breakpoint
CREATE INDEX `h1b_sponsors_key1_idx` ON `h1b_sponsors` (`key1`);