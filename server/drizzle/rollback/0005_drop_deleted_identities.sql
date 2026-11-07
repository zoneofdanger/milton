-- Rollback of 0005. Recreates deleted_identities empty, with its 0000_baseline
-- definition and the grants it held: milton_runtime (baseline), milton_app_runtime
-- (005-app-roles.sql) and milton_app_owner (000-app-owner.sql), each only where the
-- role exists. Rows deleted by 0005 are recoverable only from the pre-migration
-- snapshot. Needed only before traffic returns to app/MCP code older than #26, which
-- reads and writes this table. Run as neondb_owner:
-- psql -X -v ON_ERROR_STOP=1 -f this file. The 0005 journal row stays, so
-- re-forwarding means running 0005_drop_deleted_identities.sql by hand, as one
-- transaction: psql -1 -X -v ON_ERROR_STOP=1 -f server/drizzle/0005_drop_deleted_identities.sql
BEGIN;
CREATE TABLE "deleted_identities" (
	"identity_hash" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_identities_hash" CHECK ("deleted_identities"."identity_hash" ~ '^[a-f0-9]{64}$')
);
-- The baseline's default privileges would add UPDATE; the table never had it.
REVOKE ALL ON TABLE deleted_identities FROM milton_runtime;
GRANT SELECT, INSERT ON TABLE deleted_identities TO milton_runtime;
DO $$ BEGIN
 -- In the original grant order (000-app-owner.sql, then 005-app-roles.sql).
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='milton_app_owner') THEN
  GRANT SELECT ON public.deleted_identities TO milton_app_owner;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='milton_app_runtime') THEN
  GRANT SELECT, INSERT ON public.deleted_identities TO milton_app_runtime;
 END IF;
END $$;
COMMIT;
