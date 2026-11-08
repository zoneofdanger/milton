-- scripts/migrate.ts runs this file and its ledger row in one transaction.
-- Account deletion also removes the account's sign-in grant bindings and the
-- assistant registrations it authorized. A durable link, written when an account
-- consents to a registration and removed only by its deletion, records which
-- registrations each account authorized; disconnects, token and consent purges
-- and binding expiry never remove it.
CREATE TABLE milton_guard.client_link (
 origin_user text NOT NULL REFERENCES milton_auth."user"(id),
 client_id text NOT NULL REFERENCES milton_auth."oauthClient"("clientId") ON DELETE CASCADE,
 PRIMARY KEY (origin_user,client_id)
);
CREATE INDEX client_link_client ON milton_guard.client_link(client_id);
REVOKE ALL ON milton_guard.client_link FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
-- No consent commits between the backfill below and the gate that now writes links.
LOCK TABLE milton_auth."oauthConsent" IN SHARE MODE;
-- As 003, and the consenting account's link to the registration.
CREATE OR REPLACE FUNCTION milton_guard.consent_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $$
DECLARE b milton_guard.authorization_binding; u milton_auth."user";
BEGIN
 SELECT * INTO STRICT u FROM milton_auth."user" WHERE id=NEW."userId" FOR UPDATE;
 SELECT * INTO STRICT b FROM milton_guard.authorization_binding WHERE reference=NEW."referenceId" FOR UPDATE;
 IF b.state<>'pending' OR b.authorization_consumed OR b.pending_expires_at<now() OR b.expires_at<now()
 OR (b.origin_user,b.client_id,b."miltonIdentityIncarnation",b."miltonSecurityGeneration") IS DISTINCT FROM
 (NEW."userId",NEW."clientId",u."miltonIdentityIncarnation",u."miltonSecurityGeneration")
 OR NOT ARRAY(SELECT jsonb_array_elements_text(NEW.scopes::jsonb)) <@ b.requested_scopes
 OR NOT coalesce(ARRAY(SELECT jsonb_array_elements_text(NEW.resources::jsonb)),ARRAY[]::text[]) <@ b.resources
 THEN RAISE EXCEPTION 'invalid consent binding' USING ERRCODE='23514'; END IF;
 UPDATE milton_guard.authorization_binding SET state='revoked'
 WHERE origin_user=b.origin_user AND "miltonIdentityIncarnation"=b."miltonIdentityIncarnation"
 AND client_id=b.client_id AND reference<>b.reference AND state IN ('pending','active');
 UPDATE milton_guard.authorization_binding SET state='active',final_scopes=ARRAY(SELECT jsonb_array_elements_text(NEW.scopes::jsonb)) WHERE reference=b.reference;
 INSERT INTO milton_guard.client_link(origin_user,client_id) VALUES(b.origin_user,b.client_id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
-- Every registration an existing account has authorized: its consents, and its
-- consented bindings (Milton's own app never consents and is never linked).
INSERT INTO milton_guard.client_link(origin_user,client_id)
SELECT c."userId",c."clientId" FROM milton_auth."oauthConsent" c WHERE c."userId" IS NOT NULL
UNION
SELECT b.origin_user,b.client_id FROM milton_guard.authorization_binding b
 WHERE b.final_scopes IS NOT NULL
 AND EXISTS(SELECT 1 FROM milton_auth."user" u WHERE u.id=b.origin_user)
 AND EXISTS(SELECT 1 FROM milton_auth."oauthClient" c WHERE c."clientId"=b.client_id)
 AND NOT EXISTS(SELECT 1 FROM milton_guard.first_party_policy f WHERE f.client_id=b.client_id)
ON CONFLICT DO NOTHING;
-- As 003, and for a deletion, after the account's codes, tokens and consents:
-- each registration it authorized (deleted, or cleared when another account also
-- authorized it), then its bindings, sessions and sign-in methods, the user last.
CREATE OR REPLACE FUNCTION milton_guard.cleanup_operation(p_operation text,p_limit integer) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE op milton_guard.security_operation; rows_done integer:=0; n integer; remaining boolean; link record;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'bounded cleanup required' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT op FROM milton_guard.security_operation WHERE operation_id=p_operation;
 -- Account before operation and provider children. Missing/recreated identities
 -- never cause the operation to resolve a new account by email or current state.
 PERFORM 1 FROM milton_auth."user" WHERE id=op.origin_user AND "miltonIdentityIncarnation"=op.incarnation FOR UPDATE;
 PERFORM pg_catalog.set_config('credential.locked',op.origin_user,true);
 SELECT * INTO STRICT op FROM milton_guard.security_operation WHERE operation_id=p_operation FOR UPDATE;
 IF op.progress='complete' THEN RETURN op.progress; END IF;
 DELETE FROM milton_auth."oauthAccessToken" WHERE id IN
 (SELECT id FROM milton_auth."oauthAccessToken" WHERE "referenceId"=ANY(op.targets) ORDER BY id LIMIT p_limit);
 GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
 DELETE FROM milton_auth."oauthRefreshToken" WHERE id IN
 (SELECT r.id FROM milton_auth."oauthRefreshToken" r WHERE r."referenceId"=ANY(op.targets) AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" a WHERE a."refreshId"=r.id) ORDER BY r.id LIMIT p_limit);
 GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
 DELETE FROM milton_auth."oauthConsent" WHERE id IN
 (SELECT id FROM milton_auth."oauthConsent" WHERE "referenceId"=ANY(op.targets) ORDER BY id LIMIT p_limit);
 GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
 DELETE FROM milton_auth.verification WHERE id IN
 (SELECT id FROM milton_auth.verification WHERE (CASE WHEN value LIKE '{%' THEN value::jsonb ELSE '{}'::jsonb END)->>'referenceId'=ANY(op.targets) ORDER BY id LIMIT p_limit);
 GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
 SELECT EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" WHERE "referenceId"=ANY(op.targets)) OR
 EXISTS(SELECT 1 FROM milton_auth."oauthRefreshToken" WHERE "referenceId"=ANY(op.targets)) OR
 EXISTS(SELECT 1 FROM milton_auth."oauthConsent" WHERE "referenceId"=ANY(op.targets)) OR
 EXISTS(SELECT 1 FROM milton_auth.verification WHERE (CASE WHEN value LIKE '{%' THEN value::jsonb ELSE '{}'::jsonb END)->>'referenceId'=ANY(op.targets)) INTO remaining;
 IF NOT remaining AND op.kind='delete' AND EXISTS(SELECT 1 FROM milton_auth."user" WHERE id=op.origin_user AND "miltonIdentityIncarnation"=op.incarnation) THEN
  -- Unprivileged clients cannot be user-owned in this service. Refuse unknown retained shapes before any FK cascade.
  IF EXISTS(SELECT 1 FROM milton_auth."oauthClient" WHERE "userId"=op.origin_user) OR EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" WHERE "userId"=op.origin_user) OR EXISTS(SELECT 1 FROM milton_auth."oauthRefreshToken" WHERE "userId"=op.origin_user) OR EXISTS(SELECT 1 FROM milton_auth."oauthConsent" WHERE "userId"=op.origin_user) THEN
   RAISE EXCEPTION 'owned client deletion requires app composition' USING ERRCODE='23514'; END IF;
  -- Each registration this account authorized, under the registration's lock so
  -- a concurrent deletion or consent sees the other's link. An anonymous one no
  -- other account authorized goes with its dependents; one another account
  -- authorized keeps working for it, without its name or contacts. Milton's own
  -- app and any owned client only lose the link.
  FOR link IN SELECT l.client_id FROM milton_guard.client_link l WHERE l.origin_user=op.origin_user ORDER BY l.client_id LIMIT p_limit LOOP
   PERFORM 1 FROM milton_auth."oauthClient" WHERE "clientId"=link.client_id FOR UPDATE;
   DELETE FROM milton_guard.client_link WHERE origin_user=op.origin_user AND client_id=link.client_id;
   GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
   IF EXISTS(SELECT 1 FROM milton_auth."oauthClient" c WHERE c."clientId"=link.client_id AND c."userId" IS NULL AND c."referenceId" IS NULL)
   AND NOT EXISTS(SELECT 1 FROM milton_guard.first_party_policy f WHERE f.client_id=link.client_id) THEN
    IF EXISTS(SELECT 1 FROM milton_guard.client_link l WHERE l.client_id=link.client_id) THEN
     UPDATE milton_auth."oauthClient" SET name=NULL,contacts=NULL WHERE "clientId"=link.client_id;
    ELSE
     DELETE FROM milton_auth."oauthClient" WHERE "clientId"=link.client_id;
    END IF;
   END IF;
  END LOOP;
  -- Every reference to a binding is gone above and none can be added (bind_flow
  -- refuses while the deletion exists, and the user row goes last).
  DELETE FROM milton_guard.authorization_binding WHERE reference IN
  (SELECT reference FROM milton_guard.authorization_binding WHERE origin_user=op.origin_user ORDER BY reference LIMIT p_limit);
  GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
  DELETE FROM milton_auth.session WHERE id IN
  (SELECT id FROM milton_auth.session WHERE "userId"=op.origin_user AND "miltonIdentityIncarnation"=op.incarnation ORDER BY id LIMIT p_limit);
  GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
  DELETE FROM milton_auth.account WHERE id IN
  (SELECT id FROM milton_auth.account WHERE "userId"=op.origin_user ORDER BY id LIMIT p_limit);
  GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
  SELECT EXISTS(SELECT 1 FROM milton_auth.session WHERE "userId"=op.origin_user) OR
  EXISTS(SELECT 1 FROM milton_auth.account WHERE "userId"=op.origin_user) OR
  EXISTS(SELECT 1 FROM milton_guard.client_link WHERE origin_user=op.origin_user) OR
  EXISTS(SELECT 1 FROM milton_guard.authorization_binding WHERE origin_user=op.origin_user) INTO remaining;
  IF NOT remaining THEN
   DELETE FROM milton_auth."user" WHERE id=op.origin_user AND "miltonIdentityIncarnation"=op.incarnation;
   GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
  END IF;
 END IF;
 UPDATE milton_guard.security_operation SET cleaned_count=cleaned_count+rows_done,
 targets=CASE WHEN remaining THEN targets ELSE ARRAY[]::text[] END,
 progress=CASE WHEN remaining THEN 'tokens-cleaned' ELSE 'complete' END
 WHERE operation_id=p_operation RETURNING progress INTO op.progress;
 RETURN op.progress;
END $$;
-- The same rule for accounts deleted before this release, whose consented bindings
-- still name the registrations they authorized: cleared when a remaining account is
-- linked, otherwise deleted.
UPDATE milton_auth."oauthClient" c SET name=NULL,contacts=NULL
 WHERE c."userId" IS NULL AND c."referenceId" IS NULL
 AND NOT EXISTS(SELECT 1 FROM milton_guard.first_party_policy f WHERE f.client_id=c."clientId")
 AND EXISTS(SELECT 1 FROM milton_guard.authorization_binding b WHERE b.client_id=c."clientId" AND b.final_scopes IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM milton_auth."user" u WHERE u.id=b.origin_user))
 AND EXISTS(SELECT 1 FROM milton_guard.client_link l WHERE l.client_id=c."clientId");
DELETE FROM milton_auth."oauthClient" c
 WHERE c."userId" IS NULL AND c."referenceId" IS NULL
 AND NOT EXISTS(SELECT 1 FROM milton_guard.first_party_policy f WHERE f.client_id=c."clientId")
 AND EXISTS(SELECT 1 FROM milton_guard.authorization_binding b WHERE b.client_id=c."clientId" AND b.final_scopes IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM milton_auth."user" u WHERE u.id=b.origin_user))
 AND NOT EXISTS(SELECT 1 FROM milton_guard.client_link l WHERE l.client_id=c."clientId");
-- Bindings of accounts deleted before this release: nothing references them.
DELETE FROM milton_guard.authorization_binding b
 WHERE NOT EXISTS(SELECT 1 FROM milton_auth."user" u WHERE u.id=b.origin_user)
 AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" a WHERE a."referenceId"=b.reference)
 AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthRefreshToken" r WHERE r."referenceId"=b.reference)
 AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthConsent" c WHERE c."referenceId"=b.reference)
 AND NOT EXISTS(SELECT 1 FROM milton_auth.verification v WHERE v.id=b.code_record)
 AND NOT EXISTS(SELECT 1 FROM milton_guard.security_operation o WHERE o.progress<>'complete' AND b.reference=ANY(o.targets));
