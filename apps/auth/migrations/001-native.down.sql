-- scripts/migrate.ts runs this file and its ledger row in one transaction.
-- Native identity storage is retained on rollback. Roll back the compatible code,
-- then reapply additive mechanism migrations. Destructive teardown is never a runtime migration.
REVOKE ALL ON ALL TABLES IN SCHEMA milton_auth FROM milton_auth_runtime;
