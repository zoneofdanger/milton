-- OWNER-REVIEWED PREPARATION ONLY, after the writing baseline and native001–004.
-- Create only if absent; audit an existing role rather than changing its scope.
-- This role never logs in and is never granted to any runtime.
CREATE ROLE milton_app_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $$ BEGIN
 EXECUTE format('GRANT CREATE ON DATABASE %I TO milton_app_owner',current_database());
END $$;
GRANT USAGE ON SCHEMA public TO milton_app_owner;
GRANT REFERENCES,SELECT ON public.users TO milton_app_owner;
GRANT UPDATE(id) ON public.users TO milton_app_owner;
GRANT SELECT,INSERT,UPDATE ON public.identities TO milton_app_owner;
GRANT SELECT ON public.deleted_identities,public.trial_accounts TO milton_app_owner;
-- The app owner creates/owns milton_app. It receives no writing content,
-- native credential/schema or runtime role membership by this preparation.
