-- Offline, pre-write rollback only. Stop/drain writers and gardening first.
-- This removes only exact duplicate backfill copies. Once any native card was
-- authored or regrouped, use a forward fix: never resurrect legacy memo text.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE store_config, users, memos, memo_versions, instruction_cards,
  instruction_card_versions, memo_cards, tps_reports, save_requests, gardening_jobs IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM instruction_card_versions WHERE NOT legacy)
    OR EXISTS (SELECT 1 FROM memo_cards WHERE version<>1 OR card_id<>memo_id)
    OR EXISTS (SELECT user_id,id FROM instruction_cards EXCEPT SELECT user_id,card_id FROM memo_cards)
    OR EXISTS (SELECT 1 FROM gardening_jobs WHERE payload_json->>'source_kind'='instruction_cards')
    OR EXISTS (SELECT user_id,id FROM instruction_cards EXCEPT SELECT user_id,id FROM memos)
    OR EXISTS (SELECT user_id,id FROM memos EXCEPT SELECT user_id,id FROM instruction_cards)
    OR EXISTS (SELECT user_id,card_id,version,description,body,archived,reason,actor_json,details_json,created_at FROM instruction_card_versions
      EXCEPT SELECT user_id,memo_id,version,description,body,archived,reason,actor_json,details_json,created_at FROM memo_versions)
    OR EXISTS (SELECT user_id,memo_id,version,description,body,archived,reason,actor_json,details_json,created_at FROM memo_versions
      EXCEPT SELECT user_id,card_id,version,description,body,archived,reason,actor_json,details_json,created_at FROM instruction_card_versions) THEN
    RAISE EXCEPTION 'instruction_cards_rollback_requires_unchanged_backfill';
  END IF;
END $$;
UPDATE users u SET retained_bytes=retained_bytes-(SELECT coalesce(sum(payload_bytes),0) FROM instruction_card_versions WHERE user_id=u.id);
DROP TRIGGER memo_versions_card_append ON memo_versions;
DROP TRIGGER memo_versions_card_delete ON memo_versions;
DROP TRIGGER memos_card_delete ON memos;
DROP TABLE memo_cards, instruction_card_versions, instruction_cards;
DROP FUNCTION milton_legacy_card_append(),milton_legacy_card_delete(),milton_card_guard(),milton_card_group_guard(),milton_card_version_guard(),milton_card_version_bytes();
-- Journal reconciliation is operator-owned, in the same maintenance window.
COMMIT;
