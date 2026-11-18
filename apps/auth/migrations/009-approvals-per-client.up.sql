-- scripts/migrate.ts runs this file and its ledger row in one transaction.
-- Several approvals per account and AI client. One client ID can now stand for
-- every install of an AI (a client metadata document URL), so approving it on
-- one machine no longer revokes its approvals on the others. A consent keeps
-- the client's other active bindings and leaves its pending ones to expire on
-- their own clock; past 10 active, the oldest (earliest expires_at, which is
-- creation plus 30 days, then reference) are revoked here, so at most 10 stay
-- active. The binding being approved is always kept: it and the client's nine
-- newest other active bindings. A disconnect still revokes them all.
--
-- As 008 otherwise: the same checks and the consenting account's link to the
-- registration. CREATE OR REPLACE keeps the function's owner and privileges;
-- its SECURITY DEFINER and search path are restated. No data changes: bindings
-- already revoked stay revoked.
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
 UPDATE milton_guard.authorization_binding SET state='active',final_scopes=ARRAY(SELECT jsonb_array_elements_text(NEW.scopes::jsonb)) WHERE reference=b.reference;
 UPDATE milton_guard.authorization_binding SET state='revoked' WHERE reference IN
 (SELECT reference FROM milton_guard.authorization_binding
  WHERE origin_user=b.origin_user AND "miltonIdentityIncarnation"=b."miltonIdentityIncarnation"
  AND client_id=b.client_id AND reference<>b.reference AND state='active'
  ORDER BY expires_at DESC,reference DESC OFFSET 9);
 INSERT INTO milton_guard.client_link(origin_user,client_id) VALUES(b.origin_user,b.client_id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
