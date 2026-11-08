-- code-stopped-by: #62
-- As the milton_app owner (milton_app_owner, the role migrate.ts --app-auth runs
-- as): psql -X -v ON_ERROR_STOP=1 -f this file. Since #62 the app never stores the
-- native access token in milton_app.session and nothing has ever read the column;
-- 012 made it nullable. This drops the column, so no SQL can read the tokens older
-- rows still hold (each expired within an hour of its sign-in). DROP COLUMN does not
-- erase their bytes: they stay in those tuples until the rows are reclaimed and
-- vacuumed, and in WAL and snapshots until those age out.
-- Apply only while app code from #62 or later serves: older app code inserts the
-- column and fails every sign-in without it, so after this file the app never rolls
-- back to an image older than #62 (milton-app-token-0f7d5aa) unless the snapshot is
-- restored first. MCP never touches sessions. Rerunning converges.
-- Rollback is the pre-migration snapshot; there is no down script.
-- DROP COLUMN is a catalog change with no table rewrite, but it briefly takes an
-- exclusive lock on session. Neon drops the limits a client passes at connect, so
-- the limit is set here: a lock not free within 5 s fails this file, so sign-ins
-- queued behind its wait are held at most 5 s.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE milton_app.session DROP COLUMN IF EXISTS access_token;
COMMIT;
