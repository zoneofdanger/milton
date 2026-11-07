BEGIN;


DROP TRIGGER consent_binding ON milton_auth."oauthConsent";
DROP TRIGGER code_binding ON milton_auth.verification;
DROP TRIGGER refresh_binding ON milton_auth."oauthRefreshToken";
DROP TRIGGER access_binding ON milton_auth."oauthAccessToken";
DROP SCHEMA milton_guard CASCADE;
COMMIT;
