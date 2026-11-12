-- OWNER REVIEWED PREPARATION. Apply after Drizzle 0015_memo_evidence, before the
-- app/MCP code that reads memo_changes or the new memos and tweaks columns. Grants only;
-- rerunning converges to exactly these privileges. It restates 014-memos-roles.sql's
-- whole set for the memo tables, revoking before granting, so rerunning 014 alone would
-- drop the grants below: rerun this file after any rerun of 014. 015 changed none of
-- them (it dropped only the guide roles).
-- MCP, as in 014: saves memos (words, context, tier, served tweaks, and now the request
-- and changes state, covered by its table-wide INSERT), kinds, tweaks and their
-- citations, records each report it serves, appends cover sheet versions, forgets memos
-- (deleting their citations and orphaned tweaks) and corrects a memo's context columns,
-- never its words. It reads the keep-memos switch and never sets it. New: it inserts
-- and reads memo_changes, a save's list of what changed, and never changes or deletes
-- one.
-- App, as in 014: reads everything it shows on the TPS page, appends cover sheet
-- versions from the form, forgets memos, deletes or rewords tweaks, deletes all memos
-- with their kinds and tweaks, and sets the keep-memos switch. New: it reads
-- memo_changes, clears a memo's request (UPDATE of request only, the TPS page's Remove)
-- and records when a reworded tweak's text changed (text_changed_at).
-- Neither runtime can change a memo's words or a stored change. Neither deletes
-- citations or changes itself: forgetting a memo, deleting a tweak and account erasure
-- remove them, or clear a change's tweak, through the foreign keys' actions, which run
-- as the table owner.
BEGIN;
REVOKE ALL ON public.memos,public.memo_kinds,public.tweaks,public.tweak_citations,
 public.served_reports,public.cover_sheets,public.memo_settings,public.memo_changes
 FROM milton_app_runtime,milton_mcp_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE(kind_id,medium,summary,audience,purpose,context_updated_at)
 ON public.memos TO milton_mcp_runtime;
GRANT SELECT,INSERT ON public.memo_kinds,public.served_reports,public.cover_sheets
 TO milton_mcp_runtime;
GRANT SELECT,INSERT,DELETE ON public.tweaks TO milton_mcp_runtime;
GRANT SELECT,INSERT ON public.tweak_citations,public.memo_changes TO milton_mcp_runtime;
GRANT SELECT ON public.memo_settings TO milton_mcp_runtime;
GRANT SELECT,DELETE,UPDATE(request) ON public.memos TO milton_app_runtime;
GRANT SELECT,DELETE ON public.memo_kinds TO milton_app_runtime;
GRANT SELECT ON public.tweak_citations,public.memo_changes TO milton_app_runtime;
GRANT SELECT,DELETE,UPDATE(text,norm,text_changed_at) ON public.tweaks TO milton_app_runtime;
GRANT SELECT,INSERT ON public.cover_sheets TO milton_app_runtime;
GRANT SELECT,INSERT,UPDATE(keep_memos,updated_at) ON public.memo_settings TO milton_app_runtime;
COMMIT;
