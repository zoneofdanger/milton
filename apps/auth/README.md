# Milton auth

Dedicated Node 26 auth service for `https://auth.meetmilton.com`. Better Auth owns passwords, native Google/GitHub OAuth, email verification/recovery, cookies, OAuth/OIDC, signing and refresh. Auth never serves writing, billing, app sessions or MCP tools. `api.meetmilton.com` is unused.

## Development and checks

From the repository root, using the existing Bun toolchain:

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run --cwd apps/auth check-types
bun --no-env-file test apps/auth/test
bun --no-env-file run --cwd apps/auth build
node --experimental-strip-types apps/auth/scripts/integration.ts
```

The integration command requires Node 26 and local PostgreSQL 18 binaries (`PG_BIN`, default `/opt/homebrew/opt/postgresql@18/bin`). It checks port 55543 is free, creates a uniquely named disposable directory/cluster/database, uses separate SCRAM runtime logins, runs actual product modules/native handlers and reviewed migrations, checks ports 19911/19912 before owned HTTPS and standalone bundle listeners, and stops/removes only that owned cluster/listeners in `finally`. It loads no dotenv file, reads no live configuration and refuses external network except explicitly mocked mail/admission/social boundaries. Run with a clean environment. Do not point it at another database. Native rate windows are owner-cleared between independent flow groups; production limits remain enabled. Temporary native read wrappers in the script pause actual library reads; there are no request/environment fault controls in product code.

The production entry point is `dist/cloud-run.js`. The build includes local theme CSS, fonts, favicon, native library dependencies and the local common-password hash list. It bundles for Node, not Bun. No runtime schema migration, provisioning, runtime dependency download or third-party asset fetch occurs.

## Fixed protocol contract

Issuer `https://auth.meetmilton.com/api/auth`.

| Surface               | Issuer-relative path                                 |
| --------------------- | ---------------------------------------------------- |
| OIDC discovery        | `/.well-known/openid-configuration`                  |
| OAuth discovery       | `/.well-known/oauth-authorization-server`            |
| JWKS                  | `/jwks`                                              |
| Authorize             | `/oauth2/authorize`                                  |
| Token / refresh       | `/oauth2/token`                                      |
| UserInfo              | `/oauth2/userinfo`                                   |
| End session / confirm | `/oauth2/end-session`, `/oauth2/end-session/confirm` |
| Public DCR            | `/oauth2/register`                                   |

The one first-party app client uses confidential code/S256, `client_secret_post`, `openid profile email`, no resource and no offline grant. Exact callback: `https://app.meetmilton.com/auth/callback`; logout return: `https://app.meetmilton.com/auth/logged-out`. App sessions expire no later than the one-hour opaque access token. Renewal is a new state/nonce/PKCE code flow through the auth SSO session, never a restamp of old authority. Native SSO lasts seven days with database-backed rolling renewal; sensitive operations require proof within five minutes.

Assistants get only `https://mcp.meetmilton.com/mcp`. Access tokens are native EdDSA `at+jwt`, one-hour expiry; native rotating refresh tokens have a 30-day reference ceiling and zero replay grace. Read requires `milton:read`; write additionally requires `milton:write`. Refresh cannot widen the original binding. The consent form offers Read only or Read and write and explains that each exact memo still needs the person's approval. Scope does not prove conversation approval.

Public registration always strips browser cookies and refuses initial-access Authorization credentials. It cannot create user-owned clients, privileged resources, skip-consent flags or outbound logout configuration. Actual token authentication is native and bound to the registered method. The mounted discovery documents project the supported public profile: none/basic/post token authentication, post-only own-client introspection, basic/post revocation, no DPoP, no back-channel logout. Assertion/key-based client auth, custom claims requests, PAR/JAR, arbitrary metadata, token binding and untrusted end-session controls are refused. Native server-only client/resource/consent/user deletion paths are unavailable over HTTP and guarded against runtime SDK calls without request context. No native admin console exists.

CIMD uses the upstream Node public-address/DNS-pinned transport and accepts any `https` metadata URL on a DNS host without credentials or fragment (no IP literal or `localhost`), such as Claude Code's `https://claude.ai/oauth/claude-code-client-metadata` and Muse's `https://platform.muse.ai/oauth/client-metadata.json`; dynamic registration is already public. Informational `client_uri` may differ; functional post-logout origins remain bound. Exact native callback/resource/S256 checks and consent stay enabled, and consent shows the full client ID URL, so its host is visible. No remote logo is rendered. No raw fetch fallback is supplied.

## Public account behavior

Auth pages: `/login`, `/signup`, `/verify`, `/forgot-password`, `/reset-password`, `/consent`, `/security`. Forms use native handlers through a same-origin adapter. Native success destinations from the form adapter, including same-origin authorize hops, and direct native URL-encoded browser form POST redirects (including logout confirmation) share a fresh HTML document with an escaped meta-refresh and visible Continue link; strict `form-action 'self'` stays enabled. Native proof/redirect validation still selects the destination; the adapter creates no redirect or session authority. Direct native GET redirects, JSON/fetch responses and machine URL-encoded calls retain native status, Location and body. Deferred email changes, user update/delete, direct consent mutation, MFA, passkeys, magic links, organizations, provider-token access and admin routes are denied. Verification GET does not sign in. The original native reset-link GET validates and redirects to the form without consuming its proof; native reset consumption/hashing happens on POST. Expired links give a new-request route. Native mail callbacks capture one exact original message without provider I/O. Generic signup/reset/resend responses commit a common encrypted job or no-op receipt before returning200, including social registration that sends verification. Native proof commits and mail acceptance are separate;503 means uncertain/retryable, not proof of rollback or delivery. Successful acceptance does not mean mail arrived. If signup acceptance fails after native commit, recover through verification resend; request a new link after reset uncertainty. Small native database timing differences remain; uniform timing is not claimed.

Google and GitHub use native web callbacks, verified email and explicit linking. No implicit email merge is allowed. The native user ID remains stable when a method is linked. Fresh proof, a live original session/fence and another working method protect unlinking; the parent is locked before the child delete. Unlink advances generation and ends browser/assistant authority. Before unlink enters its native transaction, an authenticated app handoff preserves current native eligibility metadata for an existing writing account only; failure prevents removal, expired billing is irrelevant, and native-only users are never admitted. First social password uses native email recovery. All generation advances and deletion atomically retire earlier reset proofs; issuance validates the original native user snapshot under the parent lock, so a delayed request cannot recreate stale recovery authority. Password changes always rotate the current session, end other sessions and invalidate old app/assistant bindings. Native session listing is sanitized to remove reusable tokens; the security UI addresses sessions by ID and resolves an exact owned token inside auth for native revocation. Session revocation ends selected browser authority while offline assistants remain connected. Account deletion stays app/Stripe/data orchestrated.

Password policy is 15–128 Unicode code points in both original and native NFKC forms, with spaces preserved and no truncation. Native Better Auth 1.7.18 scrypt performs NFKC; equivalent forms share a password. A local, pinned normalized common-password hash list screens candidates without network transmission; provenance/license are in [THIRD_PARTY.md](THIRD_PARTY.md). It is not an exhaustive compromise database. Upstream Google/GitHub access/refresh/ID tokens are discarded by supported native database hooks after callback validation; no provider token is saved in an account cookie. The signing-key table remains native encrypted storage under AUTH_SECRET. Native code-unit maximum 256 accommodates 128 astral characters; the endpoint hook enforces the actual 128-code-point ceiling. Original and normalized expansion bounds are both checked before expensive hashing.

## Service configuration and secrets

All selected capabilities must be configured at startup:

- `AUTH_DATABASE_URL`: auth-only runtime login, verified certificate/hostname TLS even with mode omitted, pool maximum 8, bounded connect/query/statement timeouts; never the migration owner.
- `AUTH_SECRET`: stable native cookie/token encryption secret shared across auth instances.
- `AUTH_ADMISSION_SECRET`: separate auth-to-app bearer service credential.
- `AUTH_RATE_SECRET`: separate stable HMAC key for shared network/account buckets.
- `AUTH_APP_CLIENT_ID`: the owner-provisioned first-party app ID. The app alone receives its client secret.
- `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`.
- `AUTH_RESEND_API_KEY`, `AUTH_MAIL_FROM`: selected sender at `notifications.meetmilton.com`.
- `PORT`, default 8080.

Before listening, startup checks that the database login is exactly the safe `milton_auth_runtime` role. A connection failure (connect timeout or drop, `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, PostgreSQL `57P01`/`57P03`) retries after 0.5, 1, 2, then 4 seconds for about 15 seconds, logging one `auth_startup_retry` line with the attempt, delay, error class and code only; then startup fails. A role or privilege refusal fails startup at once.

`AUTH_ENCRYPTED_ENV_FILE` optionally names the mounted encrypted auth-only payload; dotenvx decrypts it with the separate platform `DOTENV_PRIVATE_KEY`, with external/native secret helpers disabled and no value logging. Three distinct dotenvx payloads/platform keys remain the selected secret boundary. The release owner supplies auth's decrypted environment through its existing approved secret injection. This source never reads a retained key. Never copy plaintext `.env*` or a platform key into an image. Never run auth with the app/MCP/Stripe payload.

Mail delivery is a separate bounded command, never a public route or request-driving task. Only native code creates/verifies proofs. `AUTH_SECRET` also derives a separate mail key through native `makeSignature` (HMAC-SHA256 domain `milton auth mail v1`, internally native `getCryptoKey`); native symmetric utilities use a version1 `$ba$1$` envelope. The authenticated encrypted payload binds the job UUID, exact original destination/URL/kind/user/incarnation/generation/expiry and full provider message, including sender. Retries use that exact body and the job UUID as Resend Idempotency-Key. There are no raw recipients, links or proofs in queue columns/logs. Current native `getCryptoKey` is an HMAC importer, not a symmetric key converter.

Back up the protected original auth secret with the selected database recovery material. Changing it without the matching prior key makes pending messages terminal unreadable on claim; ask for new links. No implicit legacy-key fallback or new key setting is added. A restore can also resurrect old native authority: closed ingress and the existing security-fence reconciliation remain mandatory. Do not restore only mail data or switch to an unrelated key to hide recovery problems.

Owner must verify sender, effective sending permission/quota, SPF/DKIM/DMARC and bounce behavior through an explicitly authorized controlled send. This build performs none. Resend documents24-hour keyed deduplication; crashes or remote-success/local-timeout remain ambiguous within vendor semantics, never universal exactly-once delivery.

At most four requests can enter native work concurrently per auth process. Atomic shared HMAC network buckets allow 120 requests/minute; account buckets allow 10/minute; native shared DB limits additionally allow only 3 password sign-ins per 10 seconds per path. Only the actual socket peer is used; caller Forwarded/X-Forwarded-For/X-Real-IP are stripped. Behind Cloud Run this conservatively groups LB peers, including those per-path sign-in limits. Do not trust the first forwarded IP. The release network gate must verify actual load-balancer chaining and capacity at those shared limits and four in-flight requests per instance before selecting a finer policy. Account buckets expire and cannot impose a permanent lockout. Body 16 KiB, headers 16 KiB, query 8 KiB, listener headers 10 seconds and request 15 seconds. Security headers are applied to finalized responses, including native handlers, static files and early refusals, preserving native cookies and, except for the browser form navigation document described above, Location, body and status. Responses are no-store, use Referrer-Policy: strict-origin and allow no CORS. Referrers carry only the origin, never paths, queries or proofs, and are suppressed on HTTPS downgrade; same-origin form POSTs retain their Origin. Strict same-origin POST Origin is required even when native test-mode checks would omit it; missing, null and foreign Origins remain refused. OAuth token exchange supports server-side clients only; foreign browser Origins are refused. Confirm the client roster at release. Cookies are Secure, HttpOnly, host-only, SameSite=Lax. No request/error/cause/credential URL logger is installed; error reporting retains class/code only. Later hosting acceptance must exclude the entire token-bearing `/api/auth/reset-password/*` path as well as verification/OAuth query strings from ingress and platform request logs; query-only redaction is insufficient. No hosted log-exclusion behavior is claimed by this build.

## Schema and owner operations

Separate NOINHERIT roles: `milton_auth_runtime`, `milton_app_runtime`, `milton_mcp_runtime`; separate NOLOGIN `milton_auth_owner`. [000-owner-prerequisites.sql](migrations/000-owner-prerequisites.sql) is a reviewable preparation plan. It is not permission to alter a live shared database. Audit source schema, inherited/default/PUBLIC grants, views/SECURITY DEFINER functions, ownership/DDL/TEMP and retained managed-auth access before granting login. App-only token/session/flow tables must have their own explicit grants; MCP cannot inherit them through a writing role. `check-role.ts` checks effective runtime rights with each real login; actual production names/schema inventories remain a release gate.

Migration order is native001, credential002, reference/lifecycle003, product004, recovery005, mail006, then the app builder's storage/mapping migration. Native001 was generated from the pinned public migration planner and checked into source; startup never generates/executes SQL. 002 gives old native users default incarnation/generation/revisions and leaves old sessions unstamped/refused. Owner-only noncycling `milton_credential.fence_ids` is retained through rollback/reapply. The runtime cannot read, allocate directly or rewind it. No managed `neon_auth` table/data is modified. Qualified SECURITY DEFINER functions use `pg_catalog, pg_temp`, explicit grants and protected columns; mechanism tables have no runtime CRUD grants.

After snapshot and explicit selection, an owner with the exact owner role may run:

```sh
node --experimental-strip-types apps/auth/scripts/migrate.ts up --apply
node --experimental-strip-types apps/auth/scripts/provision.ts --apply /private/owner/output.json
```

All runtime and owner migration/provision/maintenance pools force verified TLS. Omitted mode is safe; `sslmode=require` is upgraded to full certificate/hostname verification, and `verify-full` is accepted. Unsafe modes (including verify-ca), duplicate query options, `ssl`, libpq compatibility, client certificate/key options and ambiguous TLS keys refuse. `sslrootcert` may name an explicitly selected public CA; a disposable child can use `NODE_EXTRA_CA_CERTS` without changing system trust. No insecure environment override is supported. These commands require `AUTH_OWNER_DATABASE_URL`; provisioning additionally requires auth configuration. The provisioner uses native anonymous registration/secret hashing, then atomically promotes exactly one confidential identity-only app client and stores its first-party policy. It creates no human user. Output is an exclusive mode-0600 file outside the repository; never paste it into reports. Install the client ID in auth and ID/secret in app, using separate numeric secret versions. Repeat provisioning refuses when a fixed app exists; key/client rotation is a separately reviewed owner operation. Owner credentials never enter runtime.

`migrate.ts down --apply` first refuses any pending mail job, then removes mail006, recovery005, product004, mechanism003 and credential002, while retaining native identity rows, the migration ledger and allocator high-water. This is an offline schema rollback requiring a compatible revision; it intentionally refuses a destructive native teardown. Reapply restores mechanism defaults without reusing fences. Recovery005 retires pre-upgrade reset proofs because they lack original issuance provenance. Down preserves identity rows and never restores consumed/retired proofs. Apply with only compatible fixed writers; an older writer cannot safely issue recovery across this upgrade. Snapshot/restore and data reconciliation are separate production operations, never implied by build tests.

## Live authority, admission and lifecycle

The single reference authority is `milton_guard.authorization_binding`. Native user fences/session snapshots and exact credential CAS remain separate from library protocol state. The public Kysely adapter is decorated for credentials and original-reference cleanup at outer, reconstructed and nested transaction levels. Native token lookup captures immutable subject/client/reference before child-write transaction entry; parent locks are taken on the same Read Committed executor. A zero-row CAS throws; after-commit native errors cannot undo a committed fence.

Auth uses original validated native identity metadata (verified email and stable Google/GitHub subjects) only for app-owned trial fingerprints. Successful explicit linking makes an awaited idempotent admission handoff; app-only security status also supplies current verified metadata so deletion can preserve eligibility after an uncertain link notification. Fingerprints never establish account ownership or enter assistant claims. Auth calls authenticated `POST https://app.meetmilton.com/internal/auth/admit` only after native validation. App owns stable exact issuer/subject mapping, trials/billing and deletion fingerprints. No email-based ownership merge occurs. Exact contracts and final migration function signatures are recorded in the parent task's `auth-product-interface.md`. SQL false/NULL means refusal; SQL failure means retryable outage, never a stale positive fallback. MCP checks binding live on every tool use; app also checks original sid/incarnation/generation and unexpired native session on every local-session use.

App durably persists one UUID lifecycle operation before the first call. `begin_operation` captures the original incarnation and at most 256 immutable references under a parent lock, commits refusal before cleanup, and bumps the generation for deletion. `cleanup_operation` removes at most 16 rows per native table per call and never re-resolves current connections. Native refresh/access FK dependencies are explicitly drained before parent deletion. Sessions are capped at 64/user and methods at 8/user; binding capture at 256/user. Unknown owned-client/unbound OAuth cascade inventory refuses deletion and requires owner reconciliation. Public DCR never owns clients; no native client-management route is enabled. Retried complete operations retain the tuple indefinitely but clear the target array; this minimal idempotency record prevents a stale disconnect from capturing a newer connection. It contains no credential or writing. Do not delete operation tombstones or rewind the allocator.

Maintenance is owner-operated, bounded and scheduled separately: `cleanup_expired(1..64)` removes expired session/verification/rate rows after a day of grace without touching offline references. The same owner-only function drains expired access/refresh/consent rows before dropping expired bindings, preserving FK bounds, active offline references and incomplete operation targets. Native cleanup selects at most64 rows per native table, with parent locks for native child cleanup and one native maintenance transaction at a time. Mail006 adds separate bounded pending-candidate and terminal-receipt passes of up to64 rows each. `node --experimental-strip-types apps/auth/scripts/maintain.ts --apply` (in the auth image, `node maintain.js --apply`) makes one bounded pass; schedule only under separately selected owner authority. Rehearse its cadence/capacity before sustained public launch. Never delete a binding still referenced by an incomplete operation, retain required replay tombstones, and preserve the 30-day reference ceiling. Runtime never runs an unawaited worker.

## Release and recovery gates

[Auth service template](../../server/deploy/auth.service.template.json) is deliberately non-deployable. It has no invented revision, digest, identity or secret version. Release must pin the actual image and base images, numeric secrets and separate service identity; configure canonical auth DNS/TLS/LB health Host; exclude credential/token query URLs in platform request logs; rehearse distinct runtime grants, mixed compatible revisions, key rollover and backup restore. Existing production app/MCP descriptors remain untouched here.

Under separately selected release authority: snapshot before migration; preserve actual writing/billing account mapping and deletion history using minimal verified metadata, never private writing inspection or email ownership inference; provision real provider callbacks; observe controlled mail/social/browser flows and real Muse portal, including password login landing in the app, social navigation, consent Allow/Deny callbacks and fresh re-login for deletion in Chromium and Safari; validate all three services in a closed window; disable managed Neon Auth without deleting retained data. No dual-issuer fallback is allowed. Preserve pinned compatible rollback revisions and the numeric encryption/signing key material needed by a restored database. A restore must invalidate stale sessions/references and handle key retirement before traffic resumes. After public password accounts exist, recover with a compatible self-hosted revision or forward fix; do not re-enable managed auth.

Residual trust: a compromised trusted auth issuer can impersonate identities accepted by app/MCP. Storage isolation prevents direct writing/billing/credential cross-service reads; it does not remove issuer trust. The existing Stripe remote-success/local-timeout ambiguity is outside this service and is not repaired by auth idempotency.

## Retained-login bootstrap and delegated owner

000 is a one-time privileged preparation, not an idempotent role manager. It refuses existing auth role names. Before executing it, reconcile **all existing non-superuser logins with effective CONNECT**, including inherited rights, and whether each needs TEMP. Every selected role must exist, be a login and currently connect; `temp:true` can only preserve existing TEMP. `temp:false` refuses direct/inherited non-PUBLIC TEMP that would survive revocation. Superusers are explicitly exempt from the CONNECT inventory. Do not guess production names or run a live scan from this build. Review shared schema/default/view/function dependencies separately.

On the same privileged connection, with credentials held outside history/reports, use `psql -X -v ON_ERROR_STOP=1` and enter the owner-audited JSON (fictional example only):

```sql
SELECT set_config('milton.retained_logins',
  '[{"role":"fictional_existing_login","temp":false}]', false);
\i apps/auth/migrations/000-owner-prerequisites.sql
```

Use `[]` only after verifying there are no such connecting logins. Validation, explicit CONNECT and audited TEMP pregrants, new roles/schema creation and PUBLIC revocation are one transaction. Missing/duplicate/incomplete/inconsistent inventory refuses before privilege loss. Existing direct CONNECT is preserved; only audited required TEMP is pregranted, and auth/app/MCP receive neither TEMP nor CREATE. The migration owner alone gets database CREATE for owned schemas. Runtime LOGIN/password provisioning is a later protected owner action.

The NOLOGIN owner is reached through a **separate delegated NOINHERIT login**, granted membership with `SET TRUE, INHERIT FALSE` by the privileged role administrator (PostgreSQL18). Do not grant owner membership to a runtime login. The delegated login needs explicit database CONNECT. For interactive SQL: `SET ROLE milton_auth_owner; SELECT current_user, session_user;`. Node owner commands require `current_user='milton_auth_owner'`; plain membership is insufficient. Set connection options `-c role=milton_auth_owner` in that owner's private `AUTH_OWNER_DATABASE_URL` (URL-encoded `options=-c%20role%3Dmilton_auth_owner`). Keep its login and URL separate from `AUTH_DATABASE_URL`; never copy owner credentials into a service or job. TLS verification remains mandatory.

Migration/provision/maintenance commands refuse without their explicit `--apply` selection and separate owner environment. `migrate.ts` expects `up --apply` or `down --apply`; provision expects `--apply /private/owner/output.json`; maintenance expects `--apply`. No startup migration occurs. Read the selected SQL as the preparation/dry run; omitted apply is a refusal, not a schema change.

**Existing migration ledger crash gap:** each migration file commits separately from the ledger insert/delete. A crash can leave schema applied but unrecorded, or reversed but recorded. Stop writers/migrators, preserve the selected numeric keys/images and pre-migration snapshot, and compare actual qualified objects/functions/grants/data with that exact selected SQL and its expected ledger direction. Reconcile the ledger privately only after proving a completed file; if schema is incomplete or ambiguous, choose compatible forward repair or snapshot recovery with authority invalidation. Never blindly rerun a file, edit history, mark uncertain work complete, rewind allocator fences or resurrect retired proofs. This change documents that limit; it does not replace the migration engine.

## Bounded mail delivery and retention

```sh
# Default dry run: no environment, database or provider access.
node --experimental-strip-types apps/auth/scripts/deliver.ts
# Later selected auth-only runtime operation (not owner credentials):
node --experimental-strip-types apps/auth/scripts/deliver.ts --apply
# Compiled/container equivalent, same auth-only environment:
node deliver.js --apply
# Separately selected owner-only expiry maintenance:
node --experimental-strip-types apps/auth/scripts/maintain.ts --apply
# Compiled/container equivalent, same separate owner environment:
node maintain.js --apply
```

The auth image includes `deliver.js` and `maintain.js`; its default service command stays `cloud-run.js`. Delivery uses a verified-TLS pool of1 with3-second connect,5-second statement and6-second query limits. It considers at most16 candidates, one claim at a time, with `FOR UPDATE SKIP LOCKED`; it commits the2-minute lease/attempt before external I/O and holds no database lock over network. It stops starting work23 seconds before a90-second pass deadline, allowing bounded connect/query/network/finish completion. Native cryptography handles only a bounded40,000-character ciphertext. The prepared job has one task, no platform retries and180-second outer timeout including runtime-role checks. These are execution bounds, not an account/product cap.

Each original job has at most5 claims, backoff1/2/4/8 minutes and a five-second `redirect:error` send timeout. The15-minute delivery deadline often permits fewer attempts. A crash can consume a claimed attempt. Shared429 pause persists Retry-After (seconds/date), clamped to60 seconds–24 hours by the worker; SQL independently caps completion delays and the stored shared pause at24 hours. A valid3000-second pause still outlives individual messages, stops the pass, and leaves later unclaimed work's budgets untouched. Once pause ends, other unexpired work can resume; jobs past their own expiry cannot send. Concurrent already-in-flight work cannot be recalled. A claimed send may race security change. Sending never mints or refreshes authority;005 immediately retires affected native reset proofs. Claim/finish target original job/fences only, never a new email lookup. Missing/deleted/recreated users, generation changes and verified emails fence the relevant queued message. No native-user FK/cascade adds unbounded deletion work.

`accept_mail` accepts either one encrypted native message or a NULL no-op, under the same auth-only EXECUTE grant. Native capture validates the original identity, token/URL and finite, future, at-most-one-hour lifetime against the native process clock. SQL requires finite proof expiry later than its own clock and independently caps delivery at15 minutes/native expiry; it does not compare the native one-hour lifetime against the database clock. This trusts only the auth runtime to submit native captures, not arbitrary public expiry fields. Extreme skew can still put native expiry behind the database clock (acceptance refuses), or a database delivery deadline behind the worker clock (delivery refuses); clock alignment remains an operating prerequisite, not a new authority or lifetime extension. `claim_mail` accepts1..16 candidates; `finish_mail` affects one UUID+lease, with terminal payload clearing. No runtime has direct CRUD on `mail_job`/`mail_delivery`; app/MCP have no mail function execution. All functions have qualified storage and fixed `pg_catalog,pg_temp` search paths. Owner `cleanup_expired(1..64)` preserves native cleanup, scans at most that many pending mail candidates to expire/fence/clear, and deletes at most that many terminal/no-op receipts eligible after24 hours. There is no broad sweep in claim or finish. 006 down refuses **any** pending job, even overdue ones: drain/clear via bounded owner maintenance first.

Delivery expires at the earlier of original native expiry and15 minutes after acceptance. Terminal sent/failed/fenced/expired states clear ciphertext immediately. **Physical expiry clearing needs bounded claim/maintenance; disabled/backlogged maintenance can retain encrypted contents longer.** Receipts carry original user/fences/kind/times but no recipient/link and become eligible for deletion24 hours after acceptance; actual removal also depends on maintenance. Stateless verification expires after1 hour. Remaining native verification records are eligible for cleanup1 day after expiry;005 retires reset rows immediately on security change/deletion. Backups and vendor copies have separate retention.

### Throttle inspection and recovery (prepared, not enabled)

Prepare a count-only alert on `auth_mail_pass` with `throttled > 0` in any delivery pass, and a prepared operator check of the shared pause and aggregate pending/expired counts below. A paused pass can report zero claimed/throttled, so silence after the first429 is not evidence of recovery. Do not add message bodies, recipients, proof URLs or credentials to logs. No alert or schedule is enabled here.

The24-hour cap is an operational safeguard aligned with Resend's documented daily quota reset at midnight UTC. Resend also documents429 for monthly quota exhaustion and request rate limits; the cap does not establish this account's plan/quota or guarantee vendor recovery. Persistent monthly exhaustion requires operator reconciliation before resuming delivery. See [Resend errors](https://resend.com/docs/api-reference/errors).

Only an authorized operator, using the separate delegated NOINHERIT owner login over verified TLS, may inspect/reset the pause after independently verifying recovery. Keep `milton_auth_owner` NOLOGIN, explicitly assume it with `SET ROLE`, and never give its credentials or membership to delivery/auth/app/MCP runtimes. Disable SQL history and keep connection credentials outside command arguments/logs. The following is a prepared procedure, not a selected live action:

```sql
BEGIN;
SET LOCAL ROLE milton_auth_owner;
SET LOCAL statement_timeout = '5s';
SELECT current_user, session_user;
SELECT paused_until, clock_timestamp() AS observed_at
FROM milton_guard.mail_delivery WHERE singleton;
SELECT count(*) FILTER (WHERE expires_at > clock_timestamp()) AS unexpired,
       count(*) FILTER (WHERE expires_at <= clock_timestamp()) AS expired
FROM milton_guard.mail_job WHERE state = 'pending';
ROLLBACK;
```

Verify provider recovery privately from the relevant rate/quota/reset evidence before any reset; do not infer recovery from24 hours passing. Coordinate delivery passes so an already-in-flight429 is not being cleared. Record the inspected `paused_until` as a psql variable `observed_pause` (timestamp only), then use the same owner connection:

```sql
BEGIN;
SET LOCAL ROLE milton_auth_owner;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5s';
UPDATE milton_guard.mail_delivery SET paused_until = '-infinity'
WHERE singleton AND paused_until = :'observed_pause'::timestamptz
RETURNING paused_until;
-- COMMIT only after exactly one expected row; otherwise ROLLBACK and inspect again.
COMMIT;
```

A changed pause must be inspected again, never overwritten blindly. Reset only this singleton: do not change job expiries, attempts, leases, ciphertext, native proofs or identity fences. Resume only the separately authorized delivery cadence; new throttles require another check. Expired jobs remain undeliverable and need the existing bounded cleanup, with a fresh native request if the person still needs a link.

[Job preparation](../../server/deploy/auth-mail-job.preparation.json) is disabled, nondeployable and has no apply argument by default. No schedule is enabled by this build. Later release selection must choose cadence from effective Resend quota, backlog and cleanup throughput. A once/minute rehearsal candidate processes at most16 candidates/minute per task before failures/throttling; it is not demonstrated production capacity. Keep auth-runtime delivery separate from owner maintenance credentials.

Apply006 under closed prelaunch preparation, select only a compatible **fixed** self-hosted revision, then complete controlled provider/queue/role/restore checks before public signup or schedule enablement. The old inline-send revision retains PR-04 and is **not** a safe public fallback or a mixed writer after launch. Storage compatibility alone is not public security acceptance. Postlaunch recovery uses a compatible fixed revision or forward repair preserving queue, keys and native/app data. Preserve pinned production revisions, numeric keys and snapshots; release coordinator selection remains required.
