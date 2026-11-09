-- OWNER REVIEWED PREPARATION. Apply after Drizzle 0012_memos and 005-app-roles.sql,
-- before app/MCP code that reads memos. Grants only; rerunning converges to exactly
-- these privileges.
-- MCP: saves memos (words, context, tier, served tweaks), kinds, tweaks and their
-- citations, records each report it serves, appends cover sheet versions, forgets
-- memos (deleting their citations and orphaned tweaks) and corrects a memo's context
-- columns, never its words. It reads the keep-memos switch and never sets it.
-- App: reads everything it shows on the TPS page, appends cover sheet versions from
-- the form, forgets memos, deletes or rewords tweaks, deletes all memos with their
-- kinds and tweaks, and sets the keep-memos switch. Neither runtime can change a
-- memo's words. Neither deletes citations itself: forgetting a memo, deleting a
-- tweak and account erasure remove them through the foreign keys' cascades, which
-- run as the table owner.
BEGIN;
REVOKE ALL ON public.memos,public.memo_kinds,public.tweaks,public.tweak_citations,
 public.served_reports,public.cover_sheets,public.memo_settings
 FROM milton_app_runtime,milton_mcp_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE(kind_id,medium,summary,audience,purpose,context_updated_at)
 ON public.memos TO milton_mcp_runtime;
GRANT SELECT,INSERT ON public.memo_kinds,public.served_reports,public.cover_sheets
 TO milton_mcp_runtime;
GRANT SELECT,INSERT,DELETE ON public.tweaks TO milton_mcp_runtime;
GRANT SELECT,INSERT ON public.tweak_citations TO milton_mcp_runtime;
GRANT SELECT ON public.memo_settings TO milton_mcp_runtime;
GRANT SELECT,DELETE ON public.memos,public.memo_kinds TO milton_app_runtime;
GRANT SELECT ON public.tweak_citations TO milton_app_runtime;
GRANT SELECT,DELETE,UPDATE(text,norm) ON public.tweaks TO milton_app_runtime;
GRANT SELECT,INSERT ON public.cover_sheets TO milton_app_runtime;
GRANT SELECT,INSERT,UPDATE(keep_memos,updated_at) ON public.memo_settings TO milton_app_runtime;
COMMIT;
