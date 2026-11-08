-- As the milton_app owner (milton_app_owner, the role migrate.ts --app-auth runs
-- as): psql -X -v ON_ERROR_STOP=1 -f this file. App code from this change on
-- never stores the native access token in milton_app.session (it is used only
-- during sign-in, for UserInfo and introspection), and nothing has ever read the
-- column, so its NOT NULL goes first and the column itself in a later drop.
-- Apply before releasing that code: it inserts sessions without the column.
-- Older code still writes the column and runs unchanged on either schema, so
-- rolling the app back needs nothing here. Rerunning converges. Existing rows
-- keep their tokens, each expired within an hour of its sign-in; the drop
-- removes them.
-- Rollback is the pre-migration snapshot; there is no down script.
-- DROP NOT NULL is a catalog change with no table scan, but it briefly takes an
-- exclusive lock on session. Neon drops the limits a client passes at connect, so
-- the limit is set here: a lock not free within 5 s fails this file, so sign-ins
-- queued behind its wait are held at most 5 s.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE milton_app.session ALTER COLUMN access_token DROP NOT NULL;
COMMIT;
