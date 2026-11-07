-- scripts/migrate.ts runs this file and its ledger row in one transaction.
DROP INDEX milton_auth.session_expiry;
DROP INDEX milton_auth.verification_expiry;
DROP INDEX milton_auth.access_expiry;
DROP INDEX milton_auth.refresh_expiry;
DROP INDEX milton_guard.binding_expiry;
DROP INDEX milton_guard.rate_expiry;
DROP INDEX milton_guard.binding_user;
DROP INDEX milton_guard.operation_user;
DROP TRIGGER method_gate ON milton_auth.account;
DROP TRIGGER session_capacity ON milton_auth.session;
DROP FUNCTION milton_guard.admission_identity(text,text,text,text),milton_guard.take_rate(text,integer,integer),milton_guard.method_gate(),milton_guard.session_capacity(),milton_guard.security_status(text,text,text,text),milton_guard.list_connections(text,text,integer),milton_guard.cleanup_expired(integer);
DROP TABLE milton_guard.rate_bucket;
REVOKE DELETE ON milton_auth.account FROM milton_auth_runtime;
