-- Stop writers first. Park durable evidence with its FK, guards and byte charges intact.
-- Old runtimes cannot record new provenance: keep writes stopped until forward recovery.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE users,accepted_changes IN ACCESS EXCLUSIVE MODE;
CREATE SCHEMA IF NOT EXISTS milton_rollback;
ALTER TABLE accepted_changes SET SCHEMA milton_rollback;
COMMIT;
