-- OWNER REVIEWED PREPARATION. Apply only after auditing inherited and PUBLIC
-- grants and native001–004/005-app, after writing Drizzle 0003. No membership in
-- milton_runtime, milton_guide_worker or an owner.
-- No default privileges here: app credentials never acquire writing grants.
GRANT USAGE ON SCHEMA public TO milton_app_runtime,milton_mcp_runtime;
GRANT SELECT ON public.users,public.identities,public.store_config,
 public.instruction_cards,public.instruction_card_versions,public.samples,
 public.sample_versions,public.sample_kinds,public.guide_accounts,public.report_guides
 TO milton_app_runtime,milton_mcp_runtime;
GRANT SELECT,INSERT ON public.users TO milton_app_runtime;
-- Row locks require UPDATE on at least one column; the existing immutable-ID
-- trigger forbids changing this column, including for a compromised runtime.
GRANT UPDATE(id) ON public.users TO milton_app_runtime,milton_mcp_runtime;
GRANT DELETE ON public.users TO milton_app_runtime;
GRANT INSERT ON public.identities TO milton_app_runtime;
GRANT SELECT,INSERT,UPDATE ON public.trial_accounts,public.stripe_events TO milton_app_runtime;
GRANT SELECT(user_id,started_at,subscription_status,trial_end,current_period_start,notice_stage),UPDATE(notice_stage)
 ON public.trial_accounts TO milton_mcp_runtime;
-- usage_daily's grant went with the table (Drizzle 0008).
GRANT SELECT,INSERT,UPDATE ON public.save_requests TO milton_mcp_runtime;
-- 0002: every sample change appends; neither table is updatable by a runtime.
-- The revoke converges a rehearsal that applied the earlier candidate grant.
REVOKE UPDATE ON public.samples FROM milton_mcp_runtime;
GRANT INSERT ON public.samples,public.sample_versions TO milton_mcp_runtime;
GRANT INSERT ON public.instruction_cards,public.instruction_card_versions,public.sample_kinds,public.accepted_changes TO milton_mcp_runtime;
GRANT USAGE ON SEQUENCE public.instruction_card_position TO milton_mcp_runtime;
