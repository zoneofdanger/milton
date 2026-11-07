-- Offline rollback only. Ephemeral sessions/flows cannot become managed sessions.
-- Preserve durable eligibility and original lifecycle associations.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM milton_app.lifecycle WHERE progress<>'complete') THEN
  RAISE EXCEPTION 'unfinished app lifecycle operations require reconciliation';
 END IF;
END $$;
DROP TABLE milton_app.flow, milton_app.session;
REVOKE USAGE ON SCHEMA milton_app FROM milton_app_runtime;
COMMIT;
