-- The version is a fingerprint of the assembled documents, and reads assemble
-- from cards and samples, so the stored report snapshot is never served. Drop
-- tps_reports and what only it used: its primary key tps_reports_pkey, the
-- foreign key tps_reports_user_id_users_id_fk (with its RI triggers), the
-- checks tps_revision_positive, tps_body_limit and tps_source_hash, the
-- created_at default and the milton_runtime grant (SELECT, INSERT, UPDATE).
-- No other trigger, function, view or policy refers to it. The "ready" check
-- (stored source_hash equal to the sources) lived in code and went with the
-- code release. The tps_body_limit error code stays: saves still refuse an
-- assembled report over its cap. Release the code that no longer reads or
-- writes the table to both services first, then snapshot, then migrate; see
-- deploy/README.md "Fingerprint versions (0031)".
-- rollback/0031_fingerprint_versions.sql recreates the table empty.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Lock in the save path's order: users (the account lock), then the table.
-- Dropping the table drops its foreign key, which takes ACCESS EXCLUSIVE on
-- users; take it first (as 0030 does) rather than upgrade a weaker lock.
LOCK TABLE "users" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP TABLE "tps_reports";
