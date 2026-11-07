-- Reverses 008-drop-legacy-mapping.up.sql, as the same milton_app owner: psql -X
-- -v ON_ERROR_STOP=1 -f this file. Recreates milton_app.legacy_mapping empty, with
-- its original 005-app definition and grant (SELECT to milton_app_runtime only).
-- Its rows are recoverable only from the pre-migration snapshot. Needed only before
-- traffic returns to app code older than #26. Refuses any other role, so the table
-- never gets a different owner.
BEGIN;
DO $$ BEGIN
 IF current_user::text <> (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='milton_app') THEN
  RAISE EXCEPTION 'run as the milton_app owner';
 END IF;
END $$;
CREATE TABLE milton_app.legacy_mapping (
 legacy_hash text PRIMARY KEY CHECK(length(legacy_hash)=64),
 issuer text NOT NULL, subject text NOT NULL,
 user_id text, deleted boolean NOT NULL,
 CHECK(deleted = (user_id IS NULL)), UNIQUE(issuer,subject)
);
REVOKE ALL ON milton_app.legacy_mapping FROM PUBLIC,milton_auth_runtime,milton_mcp_runtime;
GRANT SELECT ON milton_app.legacy_mapping TO milton_app_runtime;
COMMIT;
