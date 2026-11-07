BEGIN;
CREATE TABLE milton_guard.rate_bucket (key text PRIMARY KEY, started_at timestamptz NOT NULL, hits integer NOT NULL);
CREATE FUNCTION milton_guard.take_rate(p_key text,p_window integer,p_max integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF length(p_key)<>64 OR p_window NOT BETWEEN 1 AND 3600 OR p_max NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid rate policy'; END IF;
 INSERT INTO milton_guard.rate_bucket VALUES(p_key,clock_timestamp(),1)
 ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_bucket.started_at<clock_timestamp()-make_interval(secs=>p_window) THEN 1 ELSE least(rate_bucket.hits+1,p_max+1) END,
 started_at=CASE WHEN rate_bucket.started_at<clock_timestamp()-make_interval(secs=>p_window) THEN clock_timestamp() ELSE rate_bucket.started_at END RETURNING hits INTO n;
 RETURN n<=p_max;
END $$;
CREATE FUNCTION milton_guard.method_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE subject text; u milton_auth."user";
BEGIN
 subject:=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 IF pg_catalog.current_setting('credential.locked',true) IS DISTINCT FROM subject THEN RAISE EXCEPTION 'parent lock required'; END IF;
 SELECT * INTO STRICT u FROM milton_auth."user" WHERE id=subject;
 IF TG_OP='INSERT' AND (SELECT count(*) FROM milton_auth.account WHERE "userId"=subject)>=8 THEN RAISE EXCEPTION 'method capacity'; END IF;
 IF TG_OP='UPDATE' AND (NEW."userId",NEW."providerId",NEW."accountId") IS DISTINCT FROM (OLD."userId",OLD."providerId",OLD."accountId") THEN RAISE EXCEPTION 'immutable method identity'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM milton_guard.security_operation WHERE origin_user=subject AND incarnation=u."miltonIdentityIncarnation" AND kind='delete') THEN RETURN OLD; END IF;
  IF pg_catalog.current_setting('milton.native_path',true) IS DISTINCT FROM '/unlink-account' OR NOT u."emailVerified" OR NOT EXISTS(SELECT 1 FROM milton_auth.account WHERE "userId"=subject AND id<>OLD.id AND ("providerId" IN ('google','github') OR ("providerId"='credential' AND password IS NOT NULL))) THEN RAISE EXCEPTION 'last working method protected' USING ERRCODE='23514'; END IF;
  UPDATE milton_auth."user" SET "miltonSecurityGeneration"=milton_credential.next_fence() WHERE id=subject;
  DELETE FROM milton_auth.session WHERE "userId"=subject;
  RETURN OLD;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER method_gate BEFORE INSERT OR UPDATE OR DELETE ON milton_auth.account FOR EACH ROW EXECUTE FUNCTION milton_guard.method_gate();
CREATE FUNCTION milton_guard.session_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM milton_guard.security_operation WHERE origin_user=NEW."userId" AND incarnation=NEW."miltonIdentityIncarnation" AND kind='delete') THEN RAISE EXCEPTION 'deletion pending'; END IF;
 IF (SELECT count(*) FROM milton_auth.session WHERE "userId"=NEW."userId")>=64 THEN RAISE EXCEPTION 'session capacity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER session_capacity BEFORE INSERT ON milton_auth.session FOR EACH ROW EXECUTE FUNCTION milton_guard.session_capacity();
CREATE FUNCTION milton_guard.admission_identity(p_user text,p_sid text,p_inc text,p_gen text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('verifiedEmail',u.email,'verifiedIdentities',coalesce((SELECT jsonb_agg(jsonb_build_object('provider',a."providerId",'subject',a."accountId") ORDER BY a.id) FROM milton_auth.account a WHERE a."userId"=u.id AND a."providerId" IN ('google','github')),'[]'::jsonb))
 FROM milton_auth."user" u JOIN milton_auth.session s ON s."userId"=u.id
 WHERE u.id=p_user AND s.id=p_sid AND u."emailVerified" AND s."expiresAt">now()
 AND (u."miltonIdentityIncarnation",u."miltonSecurityGeneration")=(p_inc,p_gen)
 AND (s."miltonIdentityIncarnation",s."miltonSecurityGeneration")=(p_inc,p_gen)
 AND NOT EXISTS(SELECT 1 FROM milton_guard.security_operation WHERE origin_user=p_user AND incarnation=p_inc AND kind='delete');
$$;
CREATE FUNCTION milton_guard.security_status(p_user text,p_inc text,p_gen text,p_sid text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('fresh',s."createdAt">now()-interval '5 minutes','sessionId',s.id,'verified',u."emailVerified",'verifiedEmail',u.email,'verifiedIdentities',coalesce((SELECT jsonb_agg(jsonb_build_object('provider',a."providerId",'subject',a."accountId") ORDER BY a.id) FROM milton_auth.account a WHERE a."userId"=u.id AND a."providerId" IN ('google','github')),'[]'::jsonb))
 FROM milton_auth."user" u JOIN milton_auth.session s ON s."userId"=u.id
 WHERE u.id=p_user AND s.id=p_sid AND u."emailVerified" AND s."expiresAt">now()
 AND (u."miltonIdentityIncarnation",u."miltonSecurityGeneration")=(p_inc,p_gen)
 AND (s."miltonIdentityIncarnation",s."miltonSecurityGeneration")=(p_inc,p_gen)
 AND NOT EXISTS(SELECT 1 FROM milton_guard.security_operation WHERE origin_user=p_user AND incarnation=p_inc AND kind='delete');
$$;
CREATE FUNCTION milton_guard.list_connections(p_user text,p_inc text,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'bounded list required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM milton_auth."user" WHERE id=p_user AND "miltonIdentityIncarnation"=p_inc) THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO result FROM
 (SELECT b.reference,b.client_id,b.final_scopes AS scopes,b.expires_at FROM milton_guard.authorization_binding b JOIN milton_auth."user" u ON u.id=b.origin_user
 WHERE b.origin_user=p_user AND b."miltonIdentityIncarnation"=p_inc AND b."miltonSecurityGeneration"=u."miltonSecurityGeneration" AND b.state='active' AND b.expires_at>now() ORDER BY b.reference LIMIT p_limit) q;
 RETURN result;
END $$;
CREATE INDEX binding_user ON milton_guard.authorization_binding(origin_user);
CREATE INDEX operation_user ON milton_guard.security_operation(origin_user,incarnation);
-- Session/recovery/rate housekeeping never removes offline binding authority.
CREATE FUNCTION milton_guard.cleanup_expired(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n integer; total integer:=0; target record;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'bounded maintenance required'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('milton_auth_expiry')) THEN RETURN 0; END IF;
 FOR target IN SELECT id,"userId" AS subject FROM milton_auth.session WHERE "expiresAt"<now()-interval '1 day' ORDER BY "userId",id LIMIT p_limit LOOP
  PERFORM 1 FROM milton_auth."user" WHERE id=target.subject FOR UPDATE;
  PERFORM set_config('credential.locked',target.subject,true);
  DELETE FROM milton_auth.session WHERE id=target.id AND "expiresAt"<now()-interval '1 day';
  GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
 END LOOP;
 FOR target IN SELECT id,"userId" AS subject FROM milton_auth."oauthAccessToken" WHERE "expiresAt"<now()-interval '1 day' ORDER BY "userId",id LIMIT p_limit LOOP
  PERFORM 1 FROM milton_auth."user" WHERE id=target.subject FOR UPDATE;
  DELETE FROM milton_auth."oauthAccessToken" WHERE id=target.id AND "expiresAt"<now()-interval '1 day';
  GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
 END LOOP;
 FOR target IN SELECT r.id,r."userId" AS subject FROM milton_auth."oauthRefreshToken" r WHERE r."expiresAt"<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" a WHERE a."refreshId"=r.id) ORDER BY r."userId",r.id LIMIT p_limit LOOP
  PERFORM 1 FROM milton_auth."user" WHERE id=target.subject FOR UPDATE;
  DELETE FROM milton_auth."oauthRefreshToken" r WHERE r.id=target.id AND r."expiresAt"<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" a WHERE a."refreshId"=r.id);
  GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
 END LOOP;
 FOR target IN SELECT c.id,c."userId" AS subject FROM milton_auth."oauthConsent" c JOIN milton_guard.authorization_binding b ON b.reference=c."referenceId" WHERE b.expires_at<now()-interval '1 day' ORDER BY c."userId",c.id LIMIT p_limit LOOP
  PERFORM 1 FROM milton_auth."user" WHERE id=target.subject FOR UPDATE;
  DELETE FROM milton_auth."oauthConsent" WHERE id=target.id;
  GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
 END LOOP;
 DELETE FROM milton_auth.verification WHERE id IN (SELECT id FROM milton_auth.verification WHERE "expiresAt"<now()-interval '1 day' ORDER BY id LIMIT p_limit); GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
 DELETE FROM milton_guard.rate_bucket WHERE key IN (SELECT key FROM milton_guard.rate_bucket WHERE started_at<now()-interval '1 day' ORDER BY key LIMIT p_limit); GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
 DELETE FROM milton_auth."rateLimit" WHERE id IN (SELECT id FROM milton_auth."rateLimit" WHERE "lastRequest"<extract(epoch from now()-interval '1 day')*1000 ORDER BY id LIMIT p_limit); GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
 DELETE FROM milton_guard.authorization_binding WHERE reference IN
 (SELECT b.reference FROM milton_guard.authorization_binding b WHERE (b.expires_at<now()-interval '1 day' OR (b.state='pending' AND b.pending_expires_at<now()-interval '1 day'))
 AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" a WHERE a."referenceId"=b.reference)
 AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthRefreshToken" r WHERE r."referenceId"=b.reference)
 AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthConsent" c WHERE c."referenceId"=b.reference)
 AND NOT EXISTS(SELECT 1 FROM milton_auth.verification v WHERE v.id=b.code_record)
 AND NOT EXISTS(SELECT 1 FROM milton_guard.security_operation o WHERE o.progress<>'complete' AND b.reference=ANY(o.targets)) ORDER BY b.reference LIMIT p_limit);
 GET DIAGNOSTICS n=ROW_COUNT; RETURN total+n;
END $$;
CREATE INDEX session_expiry ON milton_auth.session("expiresAt");
CREATE INDEX verification_expiry ON milton_auth.verification("expiresAt");
CREATE INDEX access_expiry ON milton_auth."oauthAccessToken"("expiresAt");
CREATE INDEX refresh_expiry ON milton_auth."oauthRefreshToken"("expiresAt");
CREATE INDEX binding_expiry ON milton_guard.authorization_binding(expires_at);
CREATE INDEX rate_expiry ON milton_guard.rate_bucket(started_at);
REVOKE ALL ON ALL TABLES IN SCHEMA milton_guard FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
REVOKE ALL ON FUNCTION milton_guard.admission_identity(text,text,text,text),milton_guard.take_rate(text,integer,integer),milton_guard.method_gate(),milton_guard.session_capacity(),milton_guard.security_status(text,text,text,text),milton_guard.list_connections(text,text,integer),milton_guard.cleanup_expired(integer) FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
GRANT EXECUTE ON FUNCTION milton_guard.admission_identity(text,text,text,text),milton_guard.take_rate(text,integer,integer) TO milton_auth_runtime;
GRANT EXECUTE ON FUNCTION milton_guard.security_status(text,text,text,text),milton_guard.list_connections(text,text,integer) TO milton_app_runtime;
GRANT DELETE ON milton_auth.account TO milton_auth_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON milton_auth."rateLimit" TO milton_auth_runtime;
COMMIT;
