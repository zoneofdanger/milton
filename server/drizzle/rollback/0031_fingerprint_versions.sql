-- Rollback of 0031. RESTORES SHAPE, NOT DATA. Recreates tps_reports empty, with
-- its primary key, foreign key, checks, created_at default and the 0024
-- milton_runtime grant (SELECT, INSERT, UPDATE). Empty is a faithful rollback
-- for serving: no read ever served the stored body. A revision before 0031
-- reading an account without a row assembles from cards and samples, writes
-- revision 1 and answers with that revision's version, so clients conflict
-- once on their next save and reread, as on the way forward. Run it before
-- routing traffic to a revision before 0031, which fails every read without
-- the table. Offline; stop writers first. Every CREATE and ADD fails if the
-- object already exists, so a partial or repeated run rolls back as a whole.
-- Run as neondb_owner. The 0031 journal row stays, so re-forwarding means
-- running 0031_fingerprint_versions.sql by hand.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "tps_reports" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tps_revision_positive" CHECK ("tps_reports"."revision" > 0),
	CONSTRAINT "tps_body_limit" CHECK (octet_length("tps_reports"."body") <= 1572864),
	CONSTRAINT "tps_source_hash" CHECK ("tps_reports"."source_hash" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "tps_reports" ADD CONSTRAINT "tps_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
GRANT SELECT, INSERT, UPDATE ON TABLE "tps_reports" TO milton_runtime;
COMMIT;
