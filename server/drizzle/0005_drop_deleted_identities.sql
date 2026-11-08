-- Since PR #26 nothing writes or reads deleted_identities: keyed trial-eligibility
-- fingerprints alone refuse a second trial. Apply only while app/MCP code from #26 or
-- later serves; older code reads and writes this table. No CASCADE: an unexpected
-- dependent fails this migration instead of being dropped with it. Rollback is the
-- pre-migration snapshot.
DROP TABLE "deleted_identities";
