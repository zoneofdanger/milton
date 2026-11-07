BEGIN;
LOCK TABLE milton_guard.mail_job IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM milton_guard.mail_job WHERE state='pending') THEN RAISE EXCEPTION 'pending mail requires bounded drain/expiry before down'; END IF;
END $$;
DROP FUNCTION milton_guard.cleanup_expired(integer);
ALTER FUNCTION milton_guard.cleanup_native_expired(integer) RENAME TO cleanup_expired;
DROP FUNCTION milton_guard.accept_mail(uuid,text,text,text,text,timestamptz,text),milton_guard.claim_mail(integer),milton_guard.finish_mail(uuid,uuid,text,integer),milton_guard.mail_fenced(milton_guard.mail_job);
DROP TABLE milton_guard.mail_job,milton_guard.mail_delivery;
COMMIT;
