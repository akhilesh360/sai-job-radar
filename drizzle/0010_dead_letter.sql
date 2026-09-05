ALTER TABLE `source_boards` ADD `failure_kind` text;--> statement-breakpoint
ALTER TABLE `source_boards` ADD `retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `source_boards` ADD `next_retry_at` text;--> statement-breakpoint
ALTER TABLE `source_boards` ADD `dead_at` text;--> statement-breakpoint
UPDATE `source_boards` SET
  `failure_kind` = CASE
    WHEN `last_error` LIKE 'HTTP 404%' OR `last_error` LIKE 'HTTP 410%' THEN 'gone'
    WHEN `last_error` LIKE 'HTTP 401%' OR `last_error` LIKE 'HTTP 403%' OR `last_error` LIKE 'HTTP 429%' THEN 'blocked'
    WHEN `last_error` LIKE 'Excluded%' THEN 'excluded'
    WHEN `last_error` LIKE '%not supported%' THEN 'unsupported'
    WHEN `last_error` LIKE '%JSON%' OR `last_error` LIKE '%Unexpected token%' THEN 'parse'
    ELSE 'transient' END,
  `retry_count` = CASE WHEN `consecutive_failures` > 0 THEN `consecutive_failures` ELSE 1 END,
  `next_retry_at` = CASE WHEN `last_error` LIKE 'Excluded%' OR `last_error` LIKE '%not supported%' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
  `dead_at` = CASE WHEN `last_error` LIKE 'Excluded%' OR `last_error` LIKE '%not supported%' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END
WHERE `status` IN ('invalid','error') AND `failure_kind` IS NULL AND `dead_at` IS NULL;
