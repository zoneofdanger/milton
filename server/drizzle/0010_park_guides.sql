-- Parks the guide pilot (server/deploy/guides.md, parked 2026-11-07): drops only the
-- trigger 0003 installed, which on every sample-version insert rescanned the account's
-- sample history and upserted report_guides. The function, the guide tables and their
-- rows, the grants and the milton_guide_worker role stay. No code needs the trigger:
-- app/MCP before this change only read guide state, and from it on read none unless
-- MILTON_GUIDES=on. While parked, report_guides stops tracking sample changes; resuming
-- (scripts/guide-enrollment.ts resume, src/guides/resume.ts) recreates the trigger and
-- resyncs every report. No row is changed here.
-- DROP TRIGGER briefly locks sample_versions exclusively. Set in the migrator's one
-- transaction, because Neon drops the limits a client passes at connect: a lock not free
-- within 5 s fails this migration instead of queueing saves behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP TRIGGER report_guide_source ON sample_versions;
