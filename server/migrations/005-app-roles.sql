-- OWNER REVIEWED PREPARATION. Apply only after auditing inherited and PUBLIC
-- grants and native001–004/005-app. No membership in milton_runtime or an owner.
-- No default privileges here: app credentials never acquire writing grants.
GRANT USAGE ON SCHEMA public TO milton_app_runtime,milton_mcp_runtime;
GRANT SELECT ON public.users,public.identities,public.store_config,
 public.instruction_cards,public.instruction_card_versions,public.samples,
 public.sample_kinds TO milton_app_runtime,milton_mcp_runtime;
GRANT SELECT,INSERT ON public.users TO milton_app_runtime;
-- Row locks require UPDATE on at least one column; the existing immutable-ID
-- trigger forbids changing this column, including for a compromised runtime.
GRANT UPDATE(id) ON public.users TO milton_app_runtime,milton_mcp_runtime;
GRANT DELETE ON public.users TO milton_app_runtime;
GRANT INSERT ON public.identities,public.deleted_identities TO milton_app_runtime;
GRANT SELECT ON public.deleted_identities TO milton_app_runtime;
GRANT SELECT,INSERT,UPDATE ON public.trial_accounts,public.stripe_events TO milton_app_runtime;
GRANT SELECT(user_id,started_at,subscription_status,trial_end,current_period_start,notice_stage),UPDATE(notice_stage)
 ON public.trial_accounts TO milton_mcp_runtime;
GRANT SELECT,INSERT,UPDATE ON public.save_requests,public.samples,public.usage_daily TO milton_mcp_runtime;
GRANT INSERT ON public.instruction_cards,public.instruction_card_versions,public.sample_kinds,public.accepted_changes TO milton_mcp_runtime;
GRANT USAGE ON SEQUENCE public.instruction_card_position TO milton_mcp_runtime;
