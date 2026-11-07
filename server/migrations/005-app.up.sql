-- Owner only; after native 001–004 and the existing writing migrations.
-- This schema NEVER participates in writing-role default grants.
BEGIN;
CREATE SCHEMA IF NOT EXISTS milton_app;
REVOKE ALL ON SCHEMA milton_app FROM PUBLIC, milton_auth_runtime, milton_mcp_runtime;
CREATE TABLE milton_app.flow (
 state_hash text PRIMARY KEY CHECK(length(state_hash)=64),
 browser_hash text NOT NULL CHECK(length(browser_hash)=64),
 nonce text NOT NULL, verifier text NOT NULL,
 destination text NOT NULL CHECK(destination IN ('/','/account/delete','/assistants')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX flow_expiry ON milton_app.flow(expires_at);
CREATE TABLE milton_app.session (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64),
 subject text NOT NULL, issuer text NOT NULL, sid text NOT NULL CHECK(length(sid)>0),
 binding text NOT NULL, incarnation text NOT NULL, generation text NOT NULL,
 email text, access_token text NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at<=created_at+interval '1 hour'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_expiry ON milton_app.session(expires_at);
CREATE TABLE IF NOT EXISTS milton_app.admission (
 issuer text NOT NULL, subject text NOT NULL, continuation text NOT NULL CHECK(length(continuation)=64),
 user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(issuer,subject,continuation)
);
-- Fingerprints are eligibility only: never ownership, never a foreign key to
-- writing. Keep the first claimant after account deletion and key rotation.
CREATE TABLE IF NOT EXISTS milton_app.trial_fingerprint (
 fingerprint text PRIMARY KEY CHECK(length(fingerprint)=64),
 first_user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS milton_app.eligibility_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 key_check text NOT NULL CHECK(length(key_check)=64)
);
CREATE TABLE IF NOT EXISTS milton_app.account_fingerprint (
 user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 fingerprint text NOT NULL REFERENCES milton_app.trial_fingerprint(fingerprint),
 PRIMARY KEY(user_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS milton_app.lifecycle (
 operation_id uuid PRIMARY KEY,
 issuer text NOT NULL, subject text NOT NULL, incarnation text NOT NULL,
 user_id text NOT NULL, client_id text NOT NULL DEFAULT '',
 requester_hash text NOT NULL CHECK(length(requester_hash)=64),
 kind text NOT NULL CHECK(kind IN ('disconnect','delete')),
 progress text NOT NULL DEFAULT 'pending' CHECK(progress IN ('pending','refused','stripe-ended','writing-erased','complete')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_account_deletion ON milton_app.lifecycle(issuer,subject,incarnation) WHERE kind='delete';
REVOKE ALL ON ALL TABLES IN SCHEMA milton_app FROM PUBLIC,milton_auth_runtime,milton_mcp_runtime;
GRANT USAGE ON SCHEMA milton_app TO milton_app_runtime;
GRANT SELECT,INSERT,DELETE ON milton_app.flow,milton_app.session TO milton_app_runtime;
GRANT SELECT,INSERT ON milton_app.admission,milton_app.trial_fingerprint,milton_app.account_fingerprint TO milton_app_runtime;
GRANT DELETE ON milton_app.admission TO milton_app_runtime;
GRANT SELECT,INSERT ON milton_app.lifecycle TO milton_app_runtime;
GRANT UPDATE(progress) ON milton_app.lifecycle TO milton_app_runtime;
GRANT SELECT ON milton_app.eligibility_policy TO milton_app_runtime;
COMMIT;
