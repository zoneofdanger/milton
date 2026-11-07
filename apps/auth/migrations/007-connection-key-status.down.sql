BEGIN;
-- Without the function every connection key is refused (fail closed); OAuth and
-- app sessions are unaffected.
DROP FUNCTION milton_guard.connection_key_status(text,text,text);
COMMIT;
