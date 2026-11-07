BEGIN;
DROP TRIGGER credential_gate ON milton_auth.account;
DROP TRIGGER session_gate ON milton_auth.session;

DROP FUNCTION milton_credential.session_gate(),milton_credential.credential_gate(),milton_credential.lock_user(text);
DROP INDEX milton_auth.credential_one;
ALTER TABLE milton_auth.session DROP COLUMN "miltonIdentityIncarnation",DROP COLUMN "miltonSecurityGeneration";
ALTER TABLE milton_auth.account DROP COLUMN "miltonCredentialRevision",DROP COLUMN "miltonExpectedCredentialRevision";
ALTER TABLE milton_auth."user" DROP COLUMN "miltonIdentityIncarnation",DROP COLUMN "miltonSecurityGeneration",DROP COLUMN "miltonIdentityCreatedTransaction";
REVOKE ALL ON milton_auth."user",milton_auth.account,milton_auth.session,milton_auth.verification FROM milton_auth_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON milton_auth."user",milton_auth.account,milton_auth.session,milton_auth.verification TO milton_auth_runtime;
DROP FUNCTION milton_credential.next_fence();
-- Deliberately retain the owner-only noncycling fence_ids high-water mark.
COMMIT;
