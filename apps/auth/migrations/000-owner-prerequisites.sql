-- PREPARATION ONLY. A privileged operator reconciles effective CONNECT/TEMP and
-- inherited/default/schema/view/function privileges against the actual database.
-- Supply an explicit audited JSON array BEFORE this file, on the SAME connection:
-- SELECT set_config('milton.retained_logins','[{"role":"audited_login","temp":false}]',false);
-- Include EVERY existing non-superuser LOGIN with effective CONNECT. Use [] only
-- after auditing that there are none. Superusers need no pregrant; runtime roles
-- must not exist yet. No login names or TEMP requirements are guessed here.
-- psql -X -v ON_ERROR_STOP=1, separately held privileged PG* credentials, then \i.
BEGIN;
DO $$
DECLARE inventory jsonb; item jsonb; selected text[]:='{}'; role_name text;
BEGIN
 BEGIN inventory:=current_setting('milton.retained_logins',true)::jsonb;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'explicit audited retained-login inventory required'; END;
 IF inventory IS NULL OR jsonb_typeof(inventory)<>'array' THEN RAISE EXCEPTION 'explicit audited retained-login inventory required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(inventory) LOOP
  role_name:=item->>'role';
  IF jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>2 OR jsonb_typeof(item->'role') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'temp') IS DISTINCT FROM 'boolean' OR role_name=ANY(selected) OR role_name IN ('milton_auth_owner','milton_auth_runtime','milton_app_runtime','milton_mcp_runtime') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND rolcanlogin AND NOT rolsuper AND has_database_privilege(oid,current_database(),'CONNECT')) THEN RAISE EXCEPTION 'inconsistent retained-login inventory'; END IF;
  -- TEMP may only preserve a privilege the selected role already effectively has.
  IF (item->>'temp')::boolean AND NOT has_database_privilege(role_name,current_database(),'TEMP') THEN RAISE EXCEPTION 'TEMP inventory does not match audited privilege'; END IF;
  IF NOT (item->>'temp')::boolean AND EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee<>0 AND a.privilege_type='TEMPORARY' AND pg_has_role(role_name,a.grantee,'USAGE')) THEN RAISE EXCEPTION 'unaudited retained TEMP dependency'; END IF;
  selected:=array_append(selected,role_name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND has_database_privilege(oid,current_database(),'CONNECT') AND NOT rolname=ANY(selected)) THEN RAISE EXCEPTION 'retained-login CONNECT inventory incomplete'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('milton_auth_owner','milton_auth_runtime','milton_app_runtime','milton_mcp_runtime')) THEN RAISE EXCEPTION 'existing auth roles require separate owner reconciliation'; END IF;
 -- Validate everything before granting or revoking anything. Transaction failure
 -- rolls back even the pregrants, role/schema creation and PUBLIC changes.
 FOR item IN SELECT value FROM jsonb_array_elements(inventory) LOOP
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),item->>'role');
  IF (item->>'temp')::boolean THEN EXECUTE format('GRANT TEMP ON DATABASE %I TO %I',current_database(),item->>'role'); END IF;
 END LOOP;
END $$;
CREATE ROLE milton_auth_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE milton_auth_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE milton_app_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE milton_mcp_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
DO $$ BEGIN
 EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC',current_database());
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO milton_auth_runtime,milton_app_runtime,milton_mcp_runtime',current_database());
 EXECUTE format('GRANT CREATE ON DATABASE %I TO milton_auth_owner',current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA milton_auth AUTHORIZATION milton_auth_owner;
REVOKE ALL ON SCHEMA milton_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA milton_auth TO milton_auth_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE milton_auth_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE milton_auth_owner REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE milton_auth_owner REVOKE ALL ON SEQUENCES FROM PUBLIC;
-- Runtime login passwords belong only in each service's secret store. No writing,
-- owner membership, PUBLIC view/function escape or TEMP path may be inherited.
COMMIT;
