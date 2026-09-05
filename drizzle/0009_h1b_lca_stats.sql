CREATE TABLE `h1b_lca_stats` (
	`name_norm` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`lcas` integer NOT NULL,
	`positions` integer NOT NULL,
	`data_lcas` integer NOT NULL,
	`data_wage_p25` integer,
	`data_wage_median` integer,
	`data_wage_p75` integer,
	`top_states` text,
	`top_data_titles` text,
	PRIMARY KEY(`name_norm`, `fiscal_year`)
);