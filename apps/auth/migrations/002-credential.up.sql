-- scripts/migrate.ts runs this file and its ledger row in one transaction.
CREATE SCHEMA IF NOT EXISTS milton_credential AUTHORIZATION milton_auth_owner;
GRANT USAGE ON SCHEMA milton_credential TO milton_auth_runtime; 
-- Kept on down/reapply: rolling back schema must never rewind an identifier allocator.
CREATE SEQUENCE IF NOT EXISTS milton_credential.fence_ids AS bigint NO CYCLE;
CREATE OR REPLACE FUNCTION milton_credential.next_fence() RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT 'f:' || pg_catalog.nextval('milton_credential.fence_ids'::pg_catalog.regclass)::text;
$$;
ALTER TABLE milton_auth."user"
 ADD COLUMN "miltonIdentityIncarnation" text NOT NULL DEFAULT milton_credential.next_fence(),
 ADD COLUMN "miltonSecurityGeneration" text NOT NULL DEFAULT milton_credential.next_fence(),
 ADD COLUMN "miltonIdentityCreatedTransaction" xid8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id();
ALTER TABLE milton_auth.account
 ADD COLUMN "miltonCredentialRevision" text NOT NULL DEFAULT milton_credential.next_fence(),
 ADD COLUMN "miltonExpectedCredentialRevision" text;
ALTER TABLE milton_auth.session ADD COLUMN "miltonIdentityIncarnation" text, ADD COLUMN "miltonSecurityGeneration" text;
-- Existing sessions cannot be promoted by stamping a current generation.
CREATE UNIQUE INDEX credential_one ON milton_auth.account("userId") WHERE "providerId"='credential';
CREATE FUNCTION milton_credential.lock_user(subject text) RETURNS TABLE(incarnation text,generation text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 RETURN QUERY SELECT u."miltonIdentityIncarnation",u."miltonSecurityGeneration" FROM milton_auth."user" u WHERE u.id=subject FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing parent' USING ERRCODE='40001'; END IF;
 PERFORM pg_catalog.set_config('credential.locked',subject,true);
END $$;
CREATE FUNCTION milton_credential.credential_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u milton_auth."user"; changed boolean;
BEGIN
 IF NEW."providerId" <> 'credential' THEN RETURN NEW; END IF;
 IF pg_catalog.current_setting('credential.locked',true) IS DISTINCT FROM NEW."userId" THEN RAISE EXCEPTION 'parent must be locked before child'; END IF;
 SELECT * INTO STRICT u FROM milton_auth."user" WHERE id=NEW."userId";
 IF TG_OP='UPDATE' THEN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."providerId" IS DISTINCT FROM OLD."providerId" OR NEW."accountId" IS DISTINCT FROM OLD."accountId" THEN RAISE EXCEPTION 'credential identity immutable'; END IF;
  IF NEW."miltonExpectedCredentialRevision" IS NULL OR NEW."miltonExpectedCredentialRevision" IS DISTINCT FROM OLD."miltonCredentialRevision" THEN RAISE EXCEPTION 'stale credential proof' USING ERRCODE='40001'; END IF;
  changed := NEW.password IS DISTINCT FROM OLD.password;
 ELSE changed := u."miltonIdentityCreatedTransaction" <> pg_catalog.pg_current_xact_id(); END IF;
 NEW."miltonExpectedCredentialRevision" := NULL;
 IF TG_OP='UPDATE' OR changed THEN NEW."miltonCredentialRevision" := milton_credential.next_fence(); END IF;
 IF changed THEN
  UPDATE milton_auth."user" SET "miltonSecurityGeneration"=milton_credential.next_fence() WHERE id=NEW."userId";
  DELETE FROM milton_auth.session WHERE "userId"=NEW."userId";
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER credential_gate BEFORE INSERT OR UPDATE ON milton_auth.account FOR EACH ROW EXECUTE FUNCTION milton_credential.credential_gate();
CREATE FUNCTION milton_credential.session_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF pg_catalog.current_setting('credential.locked',true) IS DISTINCT FROM NEW."userId" THEN RAISE EXCEPTION 'parent must be locked before session'; END IF;
 IF NOT EXISTS(SELECT 1 FROM milton_auth."user" u WHERE u.id=NEW."userId" AND u."miltonIdentityIncarnation"=NEW."miltonIdentityIncarnation" AND u."miltonSecurityGeneration"=NEW."miltonSecurityGeneration") THEN RAISE EXCEPTION 'stale session snapshot' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER session_gate BEFORE INSERT ON milton_auth.session FOR EACH ROW EXECUTE FUNCTION milton_credential.session_gate();

REVOKE ALL ON ALL TABLES IN SCHEMA milton_credential FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA milton_credential FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
GRANT EXECUTE ON FUNCTION milton_credential.next_fence(),milton_credential.lock_user(text) TO milton_auth_runtime;
REVOKE ALL ON milton_auth."user",milton_auth.account,milton_auth.session,milton_auth.verification FROM milton_auth_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON milton_auth.jwks,milton_auth."oauthClient",milton_auth."oauthResource",milton_auth."oauthClientResource",milton_auth."oauthConsent",milton_auth."oauthAccessToken",milton_auth."oauthRefreshToken" TO milton_auth_runtime;
GRANT SELECT ON milton_auth."user",milton_auth.account,milton_auth.session,milton_auth.verification TO milton_auth_runtime;
GRANT INSERT(id,name,email,"emailVerified",image,"createdAt","updatedAt"),UPDATE(name,"emailVerified",image,"updatedAt") ON milton_auth."user" TO milton_auth_runtime;
GRANT INSERT(id,"userId","accountId","providerId","accessToken","refreshToken","idToken","accessTokenExpiresAt","refreshTokenExpiresAt",scope,password,"createdAt","updatedAt","miltonExpectedCredentialRevision"),UPDATE("accessToken","refreshToken","idToken","accessTokenExpiresAt","refreshTokenExpiresAt",scope,password,"updatedAt","miltonExpectedCredentialRevision") ON milton_auth.account TO milton_auth_runtime;
GRANT INSERT(id,"userId",token,"expiresAt","ipAddress","userAgent","createdAt","updatedAt","miltonIdentityIncarnation","miltonSecurityGeneration"),UPDATE("expiresAt","updatedAt","ipAddress","userAgent"),DELETE ON milton_auth.session TO milton_auth_runtime;
GRANT INSERT,UPDATE,DELETE ON milton_auth.verification TO milton_auth_runtime;
