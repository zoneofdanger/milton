-- Run only after 0013's parking rollback, with task-aware runtimes still drained.
-- Restore caches/policy, but deliberately leave enrollment disabled.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE store_config,card_retrieval_embeddings_0013_rollback,retrieval_enrollments_0013_rollback,retrieval_policy_0013_rollback IN ACCESS EXCLUSIVE MODE;
ALTER TABLE retrieval_enrollments_0013_rollback RENAME TO retrieval_enrollments;
ALTER TABLE card_retrieval_embeddings_0013_rollback RENAME TO card_retrieval_embeddings;
UPDATE store_config c SET derivation_account_budget_micros=p.derivation_account_budget_micros,derivation_global_budget_micros=p.derivation_global_budget_micros,derivation_budget_revision=p.derivation_budget_revision,derivation_cursor=p.derivation_cursor FROM retrieval_policy_0013_rollback p WHERE c.singleton=1;
DROP TABLE retrieval_policy_0013_rollback;
COMMIT;
