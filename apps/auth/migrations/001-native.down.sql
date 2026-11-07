-- Native identity storage is retained on rollback. Roll back the compatible code,
-- then reapply additive mechanism migrations. Destructive teardown is never a runtime migration.
BEGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA milton_auth FROM milton_auth_runtime;
COMMIT;
