-- scripts/migrate.ts runs this file and its ledger row in one transaction.
CREATE SCHEMA milton_guard AUTHORIZATION milton_auth_owner;
REVOKE ALL ON SCHEMA milton_guard FROM PUBLIC;
CREATE TABLE milton_guard.authorization_binding (
 reference text PRIMARY KEY DEFAULT milton_credential.next_fence(),
 flow_key text UNIQUE NOT NULL,
 origin_user text NOT NULL, origin_session text NOT NULL,
 "miltonIdentityIncarnation" text NOT NULL,
 "miltonSecurityGeneration" text NOT NULL,
 client_id text NOT NULL, resources text[] NOT NULL,
 requested_scopes text[] NOT NULL, final_scopes text[],
 state text NOT NULL CHECK(state IN ('pending','active','revoked')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 pending_expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 authorization_consumed boolean NOT NULL DEFAULT false,
 code_record text UNIQUE
);
CREATE TABLE milton_guard.security_operation (
 operation_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
 origin_user text NOT NULL, incarnation text NOT NULL, client_id text,
 kind text NOT NULL CHECK(kind IN ('disconnect','delete')),
 targets text[] NOT NULL, cleaned_count integer NOT NULL DEFAULT 0, progress text NOT NULL DEFAULT 'refused'
 CHECK(progress IN ('refused','tokens-cleaned','complete'))
);
CREATE FUNCTION milton_guard.bind_flow(p_key text,p_user text,p_session text,p_client text,p_resources text[],p_scopes text[],p_create boolean)
 RETURNS milton_guard.authorization_binding LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $$
DECLARE u milton_auth."user"; s milton_auth.session; b milton_guard.authorization_binding;
BEGIN
 IF p_key IS NULL OR p_user IS NULL OR p_session IS NULL OR p_client IS NULL OR p_resources IS NULL OR p_scopes IS NULL THEN RAISE EXCEPTION 'missing flow association' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT u FROM milton_auth."user" WHERE id=p_user FOR UPDATE;
 IF EXISTS(SELECT 1 FROM milton_guard.security_operation WHERE origin_user=p_user AND incarnation=u."miltonIdentityIncarnation" AND kind='delete') THEN RAISE EXCEPTION 'identity deletion pending' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT s FROM milton_auth.session WHERE id=p_session AND "userId"=p_user;
 IF s."expiresAt"<now() OR (s."miltonIdentityIncarnation",s."miltonSecurityGeneration") IS DISTINCT FROM
 (u."miltonIdentityIncarnation",u."miltonSecurityGeneration") THEN
 RAISE EXCEPTION 'invalid origin session' USING ERRCODE='23514'; END IF;
 SELECT * INTO b FROM milton_guard.authorization_binding WHERE flow_key=p_key FOR UPDATE;
 IF NOT FOUND THEN
  IF NOT p_create THEN RAISE EXCEPTION 'missing original flow' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM (SELECT 1 FROM milton_guard.authorization_binding WHERE origin_user=p_user LIMIT 257) cap)>=256 THEN RAISE EXCEPTION 'binding capacity' USING ERRCODE='54000'; END IF;
  INSERT INTO milton_guard.authorization_binding(flow_key,origin_user,origin_session,"miltonIdentityIncarnation","miltonSecurityGeneration",client_id,resources,requested_scopes,state)
  VALUES(p_key,p_user,p_session,u."miltonIdentityIncarnation",u."miltonSecurityGeneration",p_client,p_resources,p_scopes,'pending') RETURNING * INTO b;
 END IF;
 IF (b.origin_user,b.origin_session,b."miltonIdentityIncarnation",b."miltonSecurityGeneration",b.client_id,b.resources)
 IS DISTINCT FROM (p_user,p_session,u."miltonIdentityIncarnation",u."miltonSecurityGeneration",p_client,p_resources)
 OR b.state='revoked' OR b.authorization_consumed OR b.pending_expires_at<now() OR b.expires_at<now()
 OR NOT p_scopes <@ b.requested_scopes OR (b.final_scopes IS NOT NULL AND NOT p_scopes <@ b.final_scopes)
 THEN RAISE EXCEPTION 'invalid original flow' USING ERRCODE='23514'; END IF;
 RETURN b;
END $$;
CREATE FUNCTION milton_guard.binding_status(p_ref text,p_user text,p_client text,p_scopes text[],p_resources text[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('reference',b.reference,'originSession',b.origin_session,
 'miltonIdentityIncarnation',b."miltonIdentityIncarnation",'miltonSecurityGeneration',b."miltonSecurityGeneration")
 FROM milton_guard.authorization_binding b JOIN milton_auth."user" u ON u.id=b.origin_user
 WHERE b.reference=p_ref AND b.origin_user=p_user AND b.client_id=p_client AND b.state='active'
 AND b.authorization_consumed AND b.expires_at>now() AND p_scopes <@ b.final_scopes AND p_resources <@ b.resources
 AND (b."miltonIdentityIncarnation",b."miltonSecurityGeneration")=(u."miltonIdentityIncarnation",u."miltonSecurityGeneration")
 $$;
CREATE FUNCTION milton_guard.consent_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
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
 RETURN NEW;
END $$;
CREATE TRIGGER consent_binding BEFORE INSERT OR UPDATE ON milton_auth."oauthConsent"
 FOR EACH ROW EXECUTE FUNCTION milton_guard.consent_gate();
CREATE TABLE milton_guard.first_party_policy(client_id text PRIMARY KEY);
CREATE FUNCTION milton_guard.code_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $$
DECLARE v jsonb; b milton_guard.authorization_binding; u milton_auth."user"; accepted text[];
BEGIN
 BEGIN v:=NEW.value::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
 IF v->>'type' IS DISTINCT FROM 'authorization_code' THEN RETURN NEW; END IF;
 SELECT * INTO STRICT u FROM milton_auth."user" WHERE id=v->>'userId' FOR UPDATE;
 SELECT * INTO STRICT b FROM milton_guard.authorization_binding WHERE reference=v->>'referenceId' FOR UPDATE;
 accepted:=string_to_array(v->'query'->>'scope',' ');
 IF b.state='pending' AND EXISTS(SELECT 1 FROM milton_guard.first_party_policy WHERE client_id=b.client_id)
 AND b.resources=ARRAY[]::text[] AND accepted <@ ARRAY['openid','profile','email'] THEN
  UPDATE milton_guard.authorization_binding SET state='active',final_scopes=accepted WHERE reference=b.reference RETURNING * INTO b;
 END IF;
 IF accepted IS NULL OR b.state<>'active' OR b.authorization_consumed OR b.pending_expires_at<now() OR b.expires_at<now()
 OR (b.origin_user,b.origin_session,b.client_id,b."miltonIdentityIncarnation",b."miltonSecurityGeneration") IS DISTINCT FROM
 (v->>'userId',v->>'sessionId',v->'query'->>'client_id',u."miltonIdentityIncarnation",u."miltonSecurityGeneration")
 OR NOT accepted <@ b.final_scopes OR NOT ARRAY(SELECT jsonb_array_elements_text(v->'resource')) <@ b.resources
 THEN RAISE EXCEPTION 'invalid or consumed authorization' USING ERRCODE='23514'; END IF;
 UPDATE milton_guard.authorization_binding SET authorization_consumed=true,code_record=NEW.id WHERE reference=b.reference;
 RETURN NEW;
END $$;
CREATE TRIGGER code_binding BEFORE INSERT ON milton_auth.verification
 FOR EACH ROW EXECUTE FUNCTION milton_guard.code_gate();
CREATE FUNCTION milton_guard.token_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $$
DECLARE b milton_guard.authorization_binding; u milton_auth."user";
BEGIN
 IF pg_catalog.current_setting('credential.locked',true) IS DISTINCT FROM NEW."userId" THEN RAISE EXCEPTION 'missing original subject parent lock before token child'; END IF;
 IF TG_OP='UPDATE' AND
 (NEW."referenceId",NEW."userId",NEW."clientId",NEW.scopes,NEW.resources) IS NOT DISTINCT FROM
 (OLD."referenceId",OLD."userId",OLD."clientId",OLD.scopes,OLD.resources) THEN RETURN NEW; END IF;
 SELECT * INTO STRICT u FROM milton_auth."user" WHERE id=NEW."userId" FOR UPDATE;
 SELECT * INTO STRICT b FROM milton_guard.authorization_binding WHERE reference=NEW."referenceId" FOR UPDATE;
 IF b.state<>'active' OR NOT b.authorization_consumed OR b.expires_at<now()
 OR (b.origin_user,b.client_id,b."miltonIdentityIncarnation",b."miltonSecurityGeneration") IS DISTINCT FROM
 (NEW."userId",NEW."clientId",u."miltonIdentityIncarnation",u."miltonSecurityGeneration")
 OR NOT ARRAY(SELECT jsonb_array_elements_text(NEW.scopes::jsonb)) <@ b.final_scopes
 OR NOT ARRAY(SELECT jsonb_array_elements_text(NEW.resources::jsonb)) <@ b.resources
 THEN RAISE EXCEPTION 'invalid token binding' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW."referenceId" IS DISTINCT FROM OLD."referenceId" THEN
 RAISE EXCEPTION 'immutable token reference' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refresh_binding BEFORE INSERT OR UPDATE ON milton_auth."oauthRefreshToken"
 FOR EACH ROW EXECUTE FUNCTION milton_guard.token_gate();
CREATE TRIGGER access_binding BEFORE INSERT OR UPDATE ON milton_auth."oauthAccessToken"
 FOR EACH ROW EXECUTE FUNCTION milton_guard.token_gate();
CREATE FUNCTION milton_guard.retire_family(p_ref text,p_user text,p_client text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM 1 FROM milton_auth."user" WHERE id=p_user FOR UPDATE;
 UPDATE milton_guard.authorization_binding SET state='revoked' WHERE reference=p_ref AND origin_user=p_user AND client_id=p_client;
END $$;
CREATE FUNCTION milton_guard.begin_operation(p_operation text,p_user text,p_inc text,p_client text,p_kind text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE previous milton_guard.security_operation; target_refs text[];
BEGIN
 IF p_operation IS NULL OR length(p_operation)<>36 OR p_kind NOT IN ('disconnect','delete') OR (p_kind='disconnect' AND p_client IS NULL) THEN
 RAISE EXCEPTION 'invalid lifecycle operation' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM milton_guard.security_operation WHERE operation_id=p_operation;
 IF FOUND THEN
  IF (previous.origin_user,previous.incarnation,previous.client_id,previous.kind) IS DISTINCT FROM (p_user,p_inc,p_client,p_kind) THEN
  RAISE EXCEPTION 'misbound lifecycle retry' USING ERRCODE='23514'; END IF;
  RETURN previous.operation_id;
 END IF;
 PERFORM 1 FROM milton_auth."user" WHERE id=p_user AND "miltonIdentityIncarnation"=p_inc FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing original identity' USING ERRCODE='23514'; END IF;
 -- Recheck after waiting on the account lock, without resolving newer targets.
 SELECT * INTO previous FROM milton_guard.security_operation WHERE operation_id=p_operation;
 IF FOUND THEN
  IF (previous.origin_user,previous.incarnation,previous.client_id,previous.kind) IS DISTINCT FROM (p_user,p_inc,p_client,p_kind) THEN
  RAISE EXCEPTION 'misbound lifecycle retry' USING ERRCODE='23514'; END IF;
  RETURN previous.operation_id;
 END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM milton_guard.authorization_binding WHERE origin_user=p_user AND "miltonIdentityIncarnation"=p_inc AND (p_kind='delete' OR client_id=p_client) LIMIT 257) bounded)>256 THEN RAISE EXCEPTION 'lifecycle target capacity' USING ERRCODE='54000'; END IF;
 SELECT coalesce(array_agg(reference ORDER BY reference),ARRAY[]::text[]) INTO target_refs
 FROM milton_guard.authorization_binding WHERE origin_user=p_user AND "miltonIdentityIncarnation"=p_inc
 AND (p_kind='delete' OR client_id=p_client);
 UPDATE milton_guard.authorization_binding SET state='revoked' WHERE reference=ANY(target_refs);
 IF p_kind='delete' THEN UPDATE milton_auth."user" SET "miltonSecurityGeneration"=milton_credential.next_fence() WHERE id=p_user; END IF;
 INSERT INTO milton_guard.security_operation(operation_id,origin_user,incarnation,client_id,kind,targets)
 VALUES(p_operation,p_user,p_inc,p_client,p_kind,target_refs);
 RETURN p_operation;
END $$;
CREATE FUNCTION milton_guard.cleanup_operation(p_operation text,p_limit integer) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE op milton_guard.security_operation; rows_done integer:=0; n integer; remaining boolean;
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
  DELETE FROM milton_auth.session WHERE id IN
  (SELECT id FROM milton_auth.session WHERE "userId"=op.origin_user AND "miltonIdentityIncarnation"=op.incarnation ORDER BY id LIMIT p_limit);
  GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
  DELETE FROM milton_auth.account WHERE id IN
  (SELECT id FROM milton_auth.account WHERE "userId"=op.origin_user ORDER BY id LIMIT p_limit);
  GET DIAGNOSTICS n=ROW_COUNT; rows_done:=rows_done+n;
  SELECT EXISTS(SELECT 1 FROM milton_auth.session WHERE "userId"=op.origin_user) OR
  EXISTS(SELECT 1 FROM milton_auth.account WHERE "userId"=op.origin_user) INTO remaining;
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
REVOKE ALL ON ALL TABLES IN SCHEMA milton_guard FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA milton_guard FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
GRANT USAGE ON SCHEMA milton_guard TO milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
GRANT EXECUTE ON FUNCTION milton_guard.bind_flow(text,text,text,text,text[],text[],boolean),milton_guard.retire_family(text,text,text) TO milton_auth_runtime;
GRANT EXECUTE ON FUNCTION milton_guard.binding_status(text,text,text,text[],text[]) TO milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
GRANT EXECUTE ON FUNCTION milton_guard.begin_operation(text,text,text,text,text),milton_guard.cleanup_operation(text,integer) TO milton_app_runtime;
CREATE FUNCTION milton_guard.app_status(p_ref text,p_user text,p_client text,p_sid text,p_inc text,p_gen text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_sid IS NOT NULL AND p_sid<>'' AND EXISTS(SELECT 1 FROM milton_guard.authorization_binding b JOIN milton_auth.session s ON s.id=b.origin_session AND s."userId"=b.origin_user JOIN milton_auth."user" u ON u.id=b.origin_user WHERE b.reference=p_ref AND b.origin_user=p_user AND b.client_id=p_client AND b.origin_session=p_sid AND b.state='active' AND b.authorization_consumed AND b.expires_at>now() AND s."expiresAt">now() AND (b."miltonIdentityIncarnation",b."miltonSecurityGeneration")=(p_inc,p_gen) AND (s."miltonIdentityIncarnation",s."miltonSecurityGeneration")=(p_inc,p_gen) AND (u."miltonIdentityIncarnation",u."miltonSecurityGeneration")=(p_inc,p_gen));
$$;
REVOKE ALL ON FUNCTION milton_guard.app_status(text,text,text,text,text,text) FROM PUBLIC,milton_auth_runtime,milton_mcp_runtime;
GRANT EXECUTE ON FUNCTION milton_guard.app_status(text,text,text,text,text,text) TO milton_app_runtime;
