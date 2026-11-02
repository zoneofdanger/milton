-- Drain task-aware MCP and worker runtimes first. Normal application rollback
-- leaves these additive tables installed. This optional database rollback parks
-- derived state and policy without erasing canonical content or spending.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE store_config,retrieval_enrollments,card_retrieval_embeddings IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM card_retrieval_embeddings WHERE status='running' AND lease_until>clock_timestamp()) THEN
    RAISE EXCEPTION 'retrieval_work_not_drained';
  END IF;
END $$;
CREATE TABLE retrieval_policy_0013_rollback AS SELECT derivation_account_budget_micros,derivation_global_budget_micros,derivation_budget_revision,derivation_cursor FROM store_config WHERE singleton=1;
UPDATE store_config SET derivation_account_budget_micros=NULL,derivation_global_budget_micros=NULL,derivation_budget_revision=0,derivation_cursor=0 WHERE singleton=1;
UPDATE retrieval_enrollments SET enabled=false;
ALTER TABLE card_retrieval_embeddings RENAME TO card_retrieval_embeddings_0013_rollback;
ALTER TABLE retrieval_enrollments RENAME TO retrieval_enrollments_0013_rollback;
-- Keep additive disabled config columns; old binaries ignore them.
COMMIT;
