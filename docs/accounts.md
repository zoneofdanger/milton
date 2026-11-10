---
name: accounts
description: Sign-in through the self-hosted auth service, app sessions and OIDC, admission and account creation, open sign-ups, and connection keys
type: behaviour
covers:
  - server/src/auth.tsx
  - server/src/auth-session.tsx
  - server/src/auth-login.tsx
  - server/src/auth-oidc.ts
  - server/src/auth-authority.ts
  - server/src/auth-admission.ts
  - server/src/auth-keys.tsx
  - server/src/auth-account.tsx
  - server/src/store/connection-keys.ts
  - server/src/store/index.ts
  - server/migrations/005-app.up.sql
  - server/migrations/013-drop-session-access-token.up.sql
  - apps/auth/src/**
  - apps/auth/scripts/**
  - apps/auth/migrations/**
  - packages/forwarded-client/**
---

# Accounts

The services and hosts are in [hosting](hosting.md); disconnecting and deleting an
account are in [deletion](deletion.md); trials started at admission are in
[billing](billing.md). Auth's own operations are in
[apps/auth/README.md](../apps/auth/README.md).

## Sign-ups

- No sign-up cap anywhere, hosted or self-hosted (Peter, 2026-10-30).
- Sign-ups are open and the only mode; the allow-list and closed modes are gone (Peter,
  2026-11-03).
- Every successful sign-in creates or finds a Milton account; there is no admission
  setting and no account-count cap. A new account starts with an empty cover sheet and
  no memos, and gets the setup offer ([setup](setup.md)).

## The auth service

Native auth (self-hosted Better Auth at `https://auth.meetmilton.com/api/auth`) hosts
sign-in with verified password/email, Google and GitHub, consent and account security.
The app never handles passwords or native cookies.

- Own form destinations and direct native URL-encoded browser form POST redirects
  (including logout confirmation) share an escaped fresh-document Continue navigation
  under strict same-origin form policy; direct GET, JSON/fetch and machine calls keep
  native redirects. Finalized native, static and refusal responses use strict-origin
  referrers (origin only, no paths, queries or proofs, suppressed on HTTPS downgrade), so
  same-origin form POSTs keep Origin while missing, null or foreign Origins stay refused.
  Responses keep their security headers and native cookies.
- Auth's wrapper guards read each POST body by its lowercased media type, and native is
  sent only that type with the body re-serialised from what the guards parsed, so no
  later decode finds a field the guards missed. A POST that is not exactly
  `application/json` or `application/x-www-form-urlencoded` (including an empty one with
  no type, or a combined comma-joined header) gets 415 before any database work.
- A new password (sign-up, reset or change) is 8 to 128 Unicode characters in both its
  original and NFKC forms, spaces kept and never truncated, and is refused if it is one
  repeated character or on the inline or pinned common-password lists. The before-hook
  refuses it before native reads or spends a reset token, so a refused reset can retry
  with the same link. New-password fields carry `minlength="8"`.
- Native Better Auth 1.7.18 scrypt performs NFKC, so equivalent forms share a password.
  The pinned common-password list is a local normalized hash list, checked without
  network transmission; it is not an exhaustive compromise database. Native's code-unit
  maximum of 256 accommodates 128 astral characters; the endpoint hook enforces the
  128-code-point ceiling, and original and normalized expansion bounds are both checked
  before expensive hashing.
- A 4xx refusal of the sign-up, sign-in, reset or change-password form re-renders that
  page (status 400, or 429 when rate-limited) with the message in a `role="alert"`
  paragraph, refilling the typed name, email, sign-in continuation and reset token but
  never a password. A reset refused for a dead token (`INVALID_TOKEN`), any 5xx
  (including "could not confirm the outcome") and every other form keep the separate
  try-again page.
- With both `AUTH_TURNSTILE_SITE_KEY` and `AUTH_TURNSTILE_SECRET_KEY` set (one alone
  fails startup), email sign-up needs a Cloudflare Turnstile token. Only `/signup` loads
  the widget, and only its CSP adds `https://challenges.cloudflare.com` to `script-src`
  and `frame-src`. The form forwards the widget's token as `x-captcha-response` (never a
  browser-sent header). The wrapper checks it with siteverify, sending only the secret
  and token, for host `auth.meetmilton.com` and action `signup`: only for a body with a
  well-formed email (else 400 before any database work, so the per-email bucket always
  applies), after the network gate has also taken a 3-in-10-seconds per-network sign-up
  bucket, and outside the native in-flight slots (at most four verifications at once,
  5 s each). With Turnstile on, native's own sign-up rule is off, so that bucket is the
  only sign-up limit; with it off, native's applies.
- A missing Turnstile token is 400; a token Cloudflare calls invalid, expired or reused,
  or one for another host or action, is 403; `internal-error`, any other or no code, a
  non-2xx, a network failure or the timeout is a retryable 503 (fail closed), and a fifth
  concurrent check is 429. A slow or failing Cloudflare stops only email sign-up;
  sign-in, resends, resets and social sign-up keep their capacity. Without the keys,
  sign-up needs no token.
- Auth's CSS, favicon and fonts keep every security header but cache like the app's
  assets (immutable at the versioned URL, otherwise no-cache); every other auth response
  stays no-store.
- Auth rate limits key each network, for every native request including the
  account-security page's own session lookups, by the client address Google's load
  balancer appends (second-to-last `X-Forwarded-For` entry, IPv4-mapped IPv6 as IPv4,
  other IPv6 by /64, never the first entry; else the socket peer). One statement first
  takes the 120-a-minute network gate (for a request proven to be the app, by its client
  secret or its own access token against native's stored hash, the token only while
  native would accept it and its binding is current, a 1,000-a-minute app ceiling
  instead) and, only if it admits, 10 a minute per account email and, except for the
  app, 60 token and 30 revoke requests a minute per client and network and 60 UserInfo
  requests a minute per bearer token and network, so a refused request creates or
  charges no other bucket.
- Better Auth's per-network-and-path limits (3 sign-in, sign-up or change-password
  attempts per 10 seconds, 3 mail requests, 30 authorize and 20 registration requests a
  minute) are each one atomic `take_rate` call; every bucket is an HMAC'd key in
  `milton_guard.rate_bucket`.
- Auth runtime and owner command pools always verify PostgreSQL TLS certificates and
  hostnames, even with the mode omitted; unsafe, libpq or duplicate URL settings refuse.
- Every native generation advance or deletion atomically retires older reset proofs;
  issuance takes the original user snapshot under the same parent lock, never the
  redemption-time generation.
- Native unlink awaits `milton-admit`'s eligibility preservation before taking its
  parent lock; it uses guarded original metadata and stores fingerprints for existing
  writing accounts only, without billing or admission.
- Bootstrap 000 validates an explicit complete retained-login CONNECT and audited TEMP
  inventory before transactional pregrants and PUBLIC revocation; a missing or
  inconsistent inventory refuses without partial privilege loss.
- Native UserInfo answers only while the token's binding is live, the same
  `binding_status` check MCP and the app make on every call. After the rate gate the
  wrapper reads a JWT's binding, subject, client (`azp`), scopes, incarnation and
  generation (native then verifies its signature) or looks an opaque token up by its
  stored hash. A missing, revoked or superseded binding gets 401 `invalid_token` with no
  claims and native is not called; a database failure is 503. So a disconnect or a begun
  deletion ends an AI token's UserInfo at once rather than at its expiry.

## Auth mail

- Native mail callbacks capture one original message; every generic sign-up, reset or
  resend success commits the same encrypted-job or no-op receipt outside native
  swallowing, with no provider I/O during HTTP; failure is an uncertain, retryable 503.
- A message to a reserved `.invalid` address is never queued: it commits the no-op
  receipt an unknown address gets, so the answer is the same and delivery has nothing to
  send. Nor is one to a domain DNS says takes no mail (a null MX, NXDOMAIN, or no MX and
  no A/AAAA). The domain is looked up before queuing whether or not a message was
  captured, within about 2 s and after giving back the request's native in-flight slot;
  a timeout, SERVFAIL or other resolver error sends anyway. A skip logs
  `auth_mail_skipped` with the kind and a 12-hex SHA-256 digest of the domain, never the
  address.
- Each address (lowercased, keyed by HMAC, not by account, so a sign-up's first message
  counts and a recreated account starts no fresh count) gets at most 3 queued messages
  of a kind an hour in a fixed `take_rate` window, whatever networks ask. Every sign-up,
  resend and reset answer runs the same statements (one bucket take, then the receipt):
  a message about to be queued takes its address's bucket, and an outcome that sends
  nothing takes one shared stand-in bucket, so asking for nothing never spends an
  address's allowance. A capped message commits the no-op receipt and logs
  `auth_mail_skipped` with reason `account_cap` and the kind only.
- Every auth message replies to `AUTH_MAIL_REPLY_TO` (default `support@meetmilton.com`,
  validated as one address) through Resend's `reply_to`, bound into the encrypted
  message like the sender; the plain-text body is unchanged.
- Auth-only mail functions lease one original message at a time for bounded delivery,
  stable job-id idempotency, finite retries and a shared Retry-After pause capped at 24
  hours by worker and SQL across passes; native authority never rebinds to a later email
  owner.
- Native capture checks its one-hour lifetime on the native clock; SQL accepts only a
  finite future proof expiry and caps mail delivery at native expiry or 15 minutes.
  Terminal transitions clear payloads, and bounded owner maintenance clears expired or
  fenced payloads and receipts eligible after 24 hours, with physical retention longer
  if maintenance is delayed.

## App sessions

- The app uses maintained code/S256 OIDC (`openid-client`, scopes
  `openid profile email`, no resource and no offline access) with shared SQL one-use
  state/nonce/verifier, an exact callback, signature, issuer, audience and subject
  checks and matching UserInfo/opaque-token proof.
- Identity-only app sessions last at most one absolute hour and never outlive their
  native opaque token (one hour); renewal is a new state/nonce/PKCE code flow through
  the auth SSO session, with no refresh or offline scope, never a restamp of old
  authority.
- The native SSO session lasts seven days with database-backed rolling renewal (renewed
  at most daily). Sensitive operations, such as creating a connection key or deleting
  the account, require a sign-in within the last five minutes.
- An app session row holds the cookie's SHA-256, the native issuer, subject, sid,
  binding, incarnation, generation and verified email, and its expiry. The native access
  token is used only within the sign-in request (UserInfo and introspection) and never
  stored (owner file `013` drops the old column). MCP cannot read app sessions.
- App cookies are host-only Secure/HttpOnly/SameSite=Lax over HTTPS; every use checks
  the original nonempty sid, immutable binding, incarnation and generation against
  native SQL, in the statement that reads the session and its identity's active
  account. No cached positive authority is accepted.
- Invalid proof refuses; an actual native 5xx, network failure or timeout is 503; an
  uncertain spent callback recovers through a new login, never a replay. Every
  discovery, token, UserInfo or introspection failure and any discovery metadata mismatch
  is logged (class and code only); a person declining sign-in (`access_denied`) is not.
- New logins reclaim at most 16 expired flows or sessions each; admission correlations
  expire after 24 hours with bounded reclaim, while eligibility and key policy and
  original operation associations remain indefinitely for their stated purposes.
- Forms require same origin, an ASCII CSRF token and unique fields; sign-in rotates CSRF.
- Browser logout removes local authority and navigates through fixed-client native RP
  logout with exact return and native confirmation, leaving offline AI grants
  independent. "Switch account" adds the one fixed logout `state` native echoes back, and
  only that exact single value sends the signed-out return on to a fresh sign-in
  (`prompt=login`).
- `/account/security` takes the person to native method, password and session
  management.

## Admission

- Auth sends admissions to `AUTH_ADMISSION_URL`, the `milton-admit` service
  ([hosting](hosting.md)). A `run.app` origin gets a metadata-server ID token for that
  origin, cached until five minutes before expiry; a loopback origin (development and
  tests) gets none and is refused in production. A failed token fetch sends nothing and
  fails like a refused admission.
- Authenticated native admission carries the exact issuer, subject and continuation and
  the native-validated verified email and bounded Google/GitHub IDs, including `[]` for
  password-only. Native validation comes first.
- Each authorize or consent accept asks the app once, though native asks twice: a second
  ask with the same admission inputs shares the first's outcome, a refusal included, and
  still runs its own `bind_flow`, so a session or binding that ends between the two is
  refused; nothing carries to another request.
- The auth service waits 5 s, ID token fetch included, for the admission. Revisit that
  when billing is turned on, since the app's worst case with Stripe is about 15 s.
- Admission (on the app's database login) checks the dedicated eligibility-key policy,
  then creates or finds one stable internal `m_*` account and its trial and applies
  existing subscription admission ([billing](billing.md)); untrusted or invalid handoffs
  cause no mapping or billing effects.
- Ownership uses the exact issuer and subject, never email, provider nickname or
  eligibility fingerprints; native linking never merges writing or restarts a trial.
- Account creation's unique identity row and billing's row lock converge under retries
  and concurrency; a new account starts empty.
- Email and stable social identities get keyed trial-eligibility fingerprints with a
  dedicated stable key and first claimant, retained after deletion; changed or
  unprovisioned keys refuse admission. They are the only second-trial block: a new
  account sharing one with an earlier account starts canceled, whether trials are on or
  off.
- An admission for an account whose deletion has begun answers 410, and native refuses
  that sign-in, consent or explicit link with 403 `account_deleting`, not a retry;
  native's own identity read already refuses one that starts after the deletion begins.

## Connection keys

How MCP checks a key is in [mcp](mcp.md).

- The Connected AIs page lists every active connection key (name, access, created, last
  used, expiry; never-expiring keys say "Never expires"; keys a security change stopped
  say so), then under "Expired keys" the 20 most recently expired, never a secret or
  hash.
- Creating a key takes a name (1 to 60 characters, one line), Read only (default) or Read
  and save, and 30, 90 (default) or 365 days or Never. It needs the form's CSRF and
  Origin checks and a sign-in within 5 minutes, since a key outlives the browser session.
- An account can have 20 active (unrevoked, unexpired) keys; creation takes the account
  lock so the cap holds.
- Under that lock, creation asks native SQL that the session's snapshot is still current
  (otherwise "Sign in again") and revokes this identity's active keys bound to any
  earlier snapshot, which can never work again.
- A key is bound at creation to the native issuer and subject and the identity
  incarnation and security generation of the validated fresh session; no runtime can
  change that binding, and it is never moved to a newer generation.
- The created key is shown once, with a Claude Code command, on a no-store page; only
  its hash is stored.
- Revoking asks on a separate page with a plain form, revokes one key, and the key is
  refused from its next request; both look the key up by id and owning account,
  independent of the list.
