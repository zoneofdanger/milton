BEGIN;
-- Live native authority for a connection key, independent of any browser session
-- or OAuth binding. True only while the key's original subject still has the
-- exact incarnation and security generation captured from the fresh session that
-- created it, is verified, and has no deletion operation. A recovery, credential
-- or method change, or deletion advances or retires that state, so a key is
-- refused for good; nothing here moves a key to a newer generation. Reads no
-- credential columns and returns nothing but the answer. NULL input is false.
CREATE FUNCTION milton_guard.connection_key_status(p_user text,p_inc text,p_gen text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(p_user IS NOT NULL AND p_inc IS NOT NULL AND p_gen IS NOT NULL AND EXISTS(SELECT 1 FROM milton_auth."user" u
 WHERE u.id=p_user AND u."emailVerified"
 AND (u."miltonIdentityIncarnation",u."miltonSecurityGeneration")=(p_inc,p_gen)
 AND NOT EXISTS(SELECT 1 FROM milton_guard.security_operation o WHERE o.origin_user=p_user AND o.incarnation=p_inc AND o.kind='delete')),false);
$$;
REVOKE ALL ON FUNCTION milton_guard.connection_key_status(text,text,text) FROM PUBLIC,milton_auth_runtime,milton_app_runtime,milton_mcp_runtime;
-- MCP checks every key call. App checks a creating session's snapshot under the
-- account lock before it stores a key or retires keys that snapshot replaced.
GRANT EXECUTE ON FUNCTION milton_guard.connection_key_status(text,text,text) TO milton_mcp_runtime,milton_app_runtime;
COMMIT;
