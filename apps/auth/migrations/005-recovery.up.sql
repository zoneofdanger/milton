-- scripts/migrate.ts runs this file and its ledger row in one transaction.
CREATE FUNCTION milton_credential.invalidate_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW."miltonIdentityIncarnation",NEW."miltonSecurityGeneration") IS DISTINCT FROM (OLD."miltonIdentityIncarnation",OLD."miltonSecurityGeneration") THEN
  DELETE FROM milton_auth.verification WHERE value=OLD.id AND identifier LIKE 'reset-password:%';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER invalidate_recovery AFTER UPDATE OF "miltonIdentityIncarnation","miltonSecurityGeneration" OR DELETE ON milton_auth."user"
FOR EACH ROW EXECUTE FUNCTION milton_credential.invalidate_recovery();
CREATE INDEX recovery_subject ON milton_auth.verification(value) WHERE identifier LIKE 'reset-password:%';
REVOKE ALL ON FUNCTION milton_credential.invalidate_recovery() FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
-- Pre-upgrade native reset rows have no original issuance provenance. Retire them.
DELETE FROM milton_auth.verification WHERE identifier LIKE 'reset-password:%';
