BEGIN;
-- Mechanism storage, deliberately no native-user FK/cascade. Lazy bounded fencing
-- cannot make native deletion unbounded or prevent its immediate authority change.
CREATE TABLE milton_guard.mail_job (
 id uuid PRIMARY KEY,
 kind text CHECK(kind IN ('verify','reset')),
 state text NOT NULL CHECK(state IN ('pending','sent','failed','fenced','expired','noop')),
 origin_user text, incarnation text, generation text,
 proof_expires_at timestamptz, payload text,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 finished_at timestamptz,
 CHECK ((payload IS NOT NULL)=(state='pending')),
 CHECK (payload IS NULL OR (length(payload) BETWEEN 100 AND 40000 AND payload LIKE '$ba$1$%')),
 CHECK ((kind IS NULL AND origin_user IS NULL AND incarnation IS NULL AND generation IS NULL AND proof_expires_at IS NULL AND state='noop') OR
 (kind IS NOT NULL AND origin_user IS NOT NULL AND incarnation IS NOT NULL AND generation IS NOT NULL AND proof_expires_at IS NOT NULL)),
 CHECK (expires_at<=created_at+interval '15 minutes'),
 CHECK (proof_expires_at IS NULL OR expires_at<=proof_expires_at),
 CHECK ((lease IS NULL)=(lease_until IS NULL))
);
CREATE TABLE milton_guard.mail_delivery (singleton boolean PRIMARY KEY CHECK(singleton), paused_until timestamptz NOT NULL);
INSERT INTO milton_guard.mail_delivery VALUES(true,'-infinity');
REVOKE ALL ON milton_guard.mail_delivery FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
CREATE INDEX mail_ready ON milton_guard.mail_job(next_at,id) WHERE state='pending';
CREATE INDEX mail_expiry ON milton_guard.mail_job(expires_at,id) WHERE state='pending';
CREATE INDEX mail_receipts ON milton_guard.mail_job(created_at,id);
REVOKE ALL ON milton_guard.mail_job FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
CREATE FUNCTION milton_guard.accept_mail(p_id uuid,p_kind text,p_user text,p_inc text,p_gen text,p_proof_expiry timestamptz,p_payload text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t timestamptz:=clock_timestamp();
BEGIN
 IF p_id IS NULL OR (p_payload IS NULL AND (p_kind IS NOT NULL OR p_user IS NOT NULL OR p_inc IS NOT NULL OR p_gen IS NOT NULL OR p_proof_expiry IS NOT NULL)) OR
 (p_payload IS NOT NULL AND (p_kind IS NULL OR p_kind NOT IN ('verify','reset') OR p_user IS NULL OR length(p_user) NOT BETWEEN 1 AND 256 OR p_inc IS NULL OR length(p_inc) NOT BETWEEN 1 AND 256 OR p_gen IS NULL OR length(p_gen) NOT BETWEEN 1 AND 256 OR p_proof_expiry IS NULL OR NOT isfinite(p_proof_expiry) OR p_proof_expiry<=t)) THEN RAISE EXCEPTION 'invalid mail acceptance' USING ERRCODE='23514'; END IF;
 -- Native capture checks the lifetime on its own clock; SQL independently caps
 -- delivery, without comparing that native lifetime to the database clock.
 INSERT INTO milton_guard.mail_job(id,kind,state,origin_user,incarnation,generation,proof_expires_at,payload,created_at,expires_at)
 VALUES(p_id,p_kind,CASE WHEN p_payload IS NULL THEN 'noop' ELSE 'pending' END,p_user,p_inc,p_gen,p_proof_expiry,p_payload,t,least(t+interval '15 minutes',coalesce(p_proof_expiry,t+interval '15 minutes')));
END $$;
-- Exact original target only. No email lookup, token re-minting or user locks.
CREATE FUNCTION milton_guard.mail_fenced(p milton_guard.mail_job) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM milton_auth."user" u
 WHERE u.id=p.origin_user AND u."miltonIdentityIncarnation"=p.incarnation AND u."miltonSecurityGeneration"=p.generation
 AND (p.kind='reset' OR (p.kind='verify' AND NOT u."emailVerified"))
 AND NOT EXISTS(SELECT 1 FROM milton_guard.security_operation o WHERE o.origin_user=p.origin_user AND o.incarnation=p.incarnation AND o.kind='delete'))
$$;
CREATE FUNCTION milton_guard.claim_mail(p_limit integer) RETURNS SETOF milton_guard.mail_job
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j milton_guard.mail_job; t timestamptz:=clock_timestamp(); terminal text;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'bounded mail claim required'; END IF;
 IF EXISTS(SELECT 1 FROM milton_guard.mail_delivery WHERE singleton AND paused_until>t) THEN RETURN; END IF;
 -- LIMIT applies BEFORE any mutation/fence/expiry work, including overdue rows.
 FOR j IN SELECT * FROM milton_guard.mail_job WHERE state='pending' AND next_at<=t AND (lease_until IS NULL OR lease_until<=t) ORDER BY next_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  terminal:=NULL;
  IF j.expires_at<=t+interval '5 seconds' THEN terminal:='expired';
  ELSIF milton_guard.mail_fenced(j) THEN terminal:='fenced';
  ELSIF j.attempts>=5 THEN terminal:='failed'; END IF;
  IF terminal IS NOT NULL THEN
   UPDATE milton_guard.mail_job SET state=terminal,payload=NULL,lease=NULL,lease_until=NULL,finished_at=t WHERE id=j.id;
  ELSE
   UPDATE milton_guard.mail_job SET attempts=attempts+1,lease=gen_random_uuid(),lease_until=t+interval '2 minutes',next_at=t+make_interval(secs=>60*(2^attempts)::integer) WHERE id=j.id RETURNING * INTO j;
   RETURN NEXT j;
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION milton_guard.finish_mail(p_id uuid,p_lease uuid,p_outcome text,p_defer integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j milton_guard.mail_job; t timestamptz:=clock_timestamp(); terminal text;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('sent','retry','failed','throttled') OR p_defer IS NULL OR p_defer<0 THEN RAISE EXCEPTION 'invalid mail completion'; END IF;
 p_defer:=least(p_defer,86400);
 SELECT * INTO j FROM milton_guard.mail_job WHERE id=p_id AND state='pending' AND lease=p_lease FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_outcome='throttled' THEN UPDATE milton_guard.mail_delivery SET paused_until=least(t+interval '24 hours',greatest(paused_until,t+make_interval(secs=>p_defer))) WHERE singleton; END IF;
 terminal:=CASE WHEN p_outcome IN ('sent','failed') THEN p_outcome WHEN j.expires_at<=t THEN 'expired' WHEN j.attempts>=5 THEN 'failed' ELSE NULL END;
 IF terminal IS NULL AND milton_guard.mail_fenced(j) THEN terminal:='fenced'; END IF;
 UPDATE milton_guard.mail_job SET state=coalesce(terminal,'pending'),payload=CASE WHEN terminal IS NULL THEN payload ELSE NULL END,
 next_at=greatest(next_at,t+make_interval(secs=>p_defer)),lease=NULL,lease_until=NULL,finished_at=CASE WHEN terminal IS NULL THEN NULL ELSE t END WHERE id=j.id;
 RETURN true;
END $$;
-- Keep original native expiry maintenance unchanged; extend with separately bounded
-- mail expiry/fence clearing and receipt deletion, both owner-only.
ALTER FUNCTION milton_guard.cleanup_expired(integer) RENAME TO cleanup_native_expired;
CREATE FUNCTION milton_guard.cleanup_expired(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE total integer; n integer; j milton_guard.mail_job; t timestamptz:=clock_timestamp(); terminal text;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'bounded maintenance required'; END IF;
 total:=milton_guard.cleanup_native_expired(p_limit);
 FOR j IN SELECT * FROM milton_guard.mail_job WHERE state='pending' ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  terminal:=CASE WHEN j.expires_at<=t THEN 'expired' WHEN milton_guard.mail_fenced(j) THEN 'fenced' ELSE NULL END;
  IF terminal IS NOT NULL THEN
   UPDATE milton_guard.mail_job SET state=terminal,payload=NULL,lease=NULL,lease_until=NULL,finished_at=t WHERE id=j.id;
   total:=total+1;
  END IF;
 END LOOP;
 DELETE FROM milton_guard.mail_job WHERE id IN (SELECT id FROM milton_guard.mail_job WHERE state<>'pending' AND created_at<t-interval '24 hours' ORDER BY created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN total+n;
END $$;
REVOKE ALL ON FUNCTION milton_guard.accept_mail(uuid,text,text,text,text,timestamptz,text),milton_guard.mail_fenced(milton_guard.mail_job),milton_guard.claim_mail(integer),milton_guard.finish_mail(uuid,uuid,text,integer),milton_guard.cleanup_expired(integer) FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
GRANT EXECUTE ON FUNCTION milton_guard.accept_mail(uuid,text,text,text,text,timestamptz,text),milton_guard.claim_mail(integer),milton_guard.finish_mail(uuid,uuid,text,integer) TO milton_auth_runtime;
COMMIT;
