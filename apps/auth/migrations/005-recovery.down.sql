-- scripts/migrate.ts runs this file and its ledger row in one transaction.
DROP TRIGGER invalidate_recovery ON milton_auth."user";
DROP FUNCTION milton_credential.invalidate_recovery();
DROP INDEX milton_auth.recovery_subject;
-- Consumed/retired authority is deliberately never restored by a rollback.
