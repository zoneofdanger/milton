-- As the milton_app owner (milton_app_owner, the role migrate.ts --app-auth runs
-- as): psql -X -v ON_ERROR_STOP=1 -f this file. Since PR #26 nothing reads
-- milton_app.legacy_mapping; the identity import that wrote it is deleted. Apply
-- only while app code from #26 or later serves: older code reads it at first
-- sign-in. 005-app.up.sql no longer creates it, so a database installed from it
-- has none and this is a no-op there. No CASCADE: an unexpected dependent fails
-- this file instead of being dropped with it. Rollback is the pre-migration
-- snapshot.
BEGIN;
DROP TABLE IF EXISTS milton_app.legacy_mapping;
COMMIT;
