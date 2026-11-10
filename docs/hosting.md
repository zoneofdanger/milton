---
name: hosting
description: Where Milton runs (Cloud Run services, the Vercel site), startup and configuration, every HTTP request, static assets and the operation scripts
type: reference
covers:
  - server/src/cloud-run.ts
  - server/src/environment.ts
  - server/src/config.ts
  - server/src/index.ts
  - server/src/cloud-app.ts
  - server/src/http.ts
  - server/src/assets.ts
  - server/src/error-log.ts
  - server/Dockerfile
  - server/scripts/**
  - packages/forwarded-client/**
---

# Hosting

Release, rollback and cloud resources are procedure, in
[the hosting runbook](../server/deploy/README.md). Local setup and environment variables
are in [server/README.md](../server/README.md).

## Services

| Surface                                | Runtime and hosting                                              |
| -------------------------------------- | ---------------------------------------------------------------- |
| `meetmilton.com`, `www.meetmilton.com` | Static Astro, Vercel ([site](site.md))                           |
| `app.meetmilton.com`                   | Hono JSX and Vite theme assets, Cloud Run `milton-app`           |
| `mcp.meetmilton.com`                   | Hono MCP, Cloud Run `milton-mcp`, Google external HTTPS balancer |
| `auth.meetmilton.com`                  | Self-hosted Better Auth (`apps/auth`), Cloud Run `milton-auth`   |
| none (`run.app`, invoker-only)         | Auth's admission calls, Cloud Run `milton-admit`, no balancer    |

- Bun installs, builds and tests; Node 26 LTS runs deployed server code.
- Neon PostgreSQL is the source of truth ([database](database.md)).
- Sign-in has been the self-hosted auth service since 2026-11-07. It has its own host,
  issuer and runtime role; exact verified issuer and subject map to retained internal
  account IDs. App OIDC sessions and MCP native bindings have separate authority
  ([accounts](accounts.md)).
- The retired Vercel app/MCP project and the migration validation services are
  decommissioned; there is no Vercel backend failover. The spend-alert worker and its
  scheduler were removed. App and MCP canonical URLs are unchanged since the move.
- Runtime rollback uses Cloud Run revision traffic, never older memo or TPS data;
  preserve the current revisions, pinned images and numeric secret versions.

## The image and startup

- One Docker image runs as the app, MCP and admission services, and `MILTON_SERVICE`
  picks `app`, `mcp` or `admit`; any other value fails startup. The image builds with
  Bun, then ships only the bundle and public assets to a non-root Node container.
- The app role serves browser pages and an exact list of public assets; the MCP role
  needs no browser cookie secret.
- `admit` (`milton-admit`) serves only auth's `POST /internal/auth/admit` and
  `/internal/auth/preserve-eligibility`; everything else is 404, and the app and MCP serve
  no `/internal/` path. It is not behind the load balancer: Cloud Run's invoker check
  admits only auth's service account, whose Google ID token auth sends in
  `X-Serverless-Authorization`, and the admission bearer stays the second check. It
  reads only `AUTH_ISSUER`, `DATABASE_URL`, `AUTH_ADMISSION_SECRET`,
  `MILTON_TRIAL_FINGERPRINT_KEY` and the Stripe settings.
- Startup decrypts a dotenvx payload file (`MILTON_ENCRYPTED_ENV_FILE`) with a separate
  platform-held `DOTENV_PRIVATE_KEY`; missing or invalid decryption fails closed, and
  existing platform values take precedence. Without a payload file the runtime uses its
  environment directly.
- Startup fails on bad URLs, a missing or short app client or eligibility secret (admit:
  a missing or short admission or eligibility secret or a bad issuer), a bad support
  email, a bad port, or an unknown service name.
- Auth startup checks its runtime role before listening; connection failures retry with
  backoff for about 15 seconds, while a role refusal fails at once. App and MCP startup
  do no database work.
- Plain HTTP is allowed only on loopback outside production.
- The server listens on `0.0.0.0:$PORT`. On SIGTERM it stops accepting requests, closes
  the database pools after in-flight requests, and force-exits after 8 seconds.

## Every HTTP request

- The load balancer upgrades HTTP to HTTPS with a 308 redirect that keeps the method.
- A request is refused unless its Host matches that service's canonical host; direct
  `run.app` requests to the app and MCP are refused.
- The app rewrites each URL to its configured origin, because TLS ends upstream.
- Bodies over 256 KiB get a 413 before parsing, auth or database work; the Stripe
  webhook keeps its own bound, also 256 KiB.
- `/mcp` goes to the MCP handler on the MCP service ([mcp](mcp.md)) and returns 404 on
  the app.
- `GET /health` returns ok.
- `/.well-known/oauth-protected-resource` publishes the resource, its auth issuer and the
  `milton:read` and `milton:write` scopes.
- Any other path on the MCP host redirects to the app host with a 308.
- Static files are served from a fixed list of six (the stylesheet, two favicons and
  three fonts), never arbitrary paths. A URL whose `?v=` matches the bytes' build hash
  caches for a year as immutable; any other URL revalidates by ETag; CSS and SVG go out
  brotli or gzip per Accept-Encoding.
- Errors that escape the routes show browsers a "PC LOAD LETTER" page, and everything
  else gets a JSON 503.
- Error logs hold only the location, class name and code, never messages or tokens.
- The client address for per-network limits comes from `packages/forwarded-client`: the
  second-to-last `X-Forwarded-For` entry Google's load balancer appends, never the first.

## Operation scripts

All under `server/scripts/`.

- `build.ts` builds the CSS with Vite, versions the public assets by content hash, and
  bundles the Cloud Run and end-to-end check (`e2e.js`, the `milton-e2e-daily` job)
  entries with Bun, minified except identifiers, with source maps the image leaves out.
- `dev.ts` serves the app on loopback and rebuilds the CSS on change.
- `migrate.ts` applies writing migrations only as `neondb_owner`; explicit `--app-auth`
  applies the app-only migration 005 after native 004 as an approved app migration
  owner, with no runtime startup migration. It takes the owner connection from
  `MILTON_OWNER_DATABASE_URL` for a release (set but empty is refused), otherwise from
  `server/.dev.vars`, and never from an inherited `DATABASE_URL`.
- `check-mcp.ts` holds the SDK client check `mcp.test.ts` runs ([mcp](mcp.md)).
- `check-auth-integration.ts` builds actual product modules with production
  minification under Node 26 and PostgreSQL 18 and mocks only external boundaries.
- `check-runtime-role.ts` audits selected NOINHERIT app/MCP roles, ownership, DDL/TEMP,
  native and app credential and function boundaries, and the role's own 20 s statement
  and 10 s lock timeouts ([database](database.md)).
- `probe-forms.ts` confirms a signed-out form post passes CSRF.
- `monitoring.ts` plans production alerts from `server/deploy/monitoring/` and, with
  `--apply`, upserts them; dry run by default.
- `test-account.ts` (owner only) provisions the fictional end-to-end account
  (`e2e@milton-test.invalid`): its Milton account first, created by the owner, marked
  `test_account`, with no trial row and bound to a pre-chosen native id, so sign-in,
  checkout and the backfill never call Stripe for it; then the native user with a
  verified `.invalid` email and a random password, created last and without queuing any
  mail, so nobody can sign in to an unmarked account; a browser sign-in; and a 365-day
  read-and-save key minted through the app's form. It writes the three values to a new
  mode-0600 env file and refuses an existing email or file and any address outside
  `.invalid`, before any write; after a failure, `--resume` with the same file converges
  on the marked account, verifying it before signing in.
- `e2e.ts` checks a deployment end to end on the test account only: a browser sign-in
  (following redirects, Continue pages and native's JSON redirects, which native sends
  because Node's fetch always says `Sec-Fetch-Mode: cors`, only to the app and auth
  origins) that must show the account and list the key's public id before the key is
  sent anywhere; an MCP connection with that key listing exactly the three tools; then a
  gate before any write (no cover sheet, no tweaks, and at most 5 memos, every one this
  check's own: kind `e2e check`, your words); forgetting those leftovers; an empty
  baseline; a marked fictional final-only memo saved (tier `own`, receipt
  `Kept memo: e2e check, your words.`), read fresh by a new session with its summary and
  quoted final as the only example, forgotten; and a final read equal to the baseline
  (empty, same cover sheet version, no memos, tweaks or examples). It prints one JSON line
  per step with no secret or memo text; a key under 30 days from expiry warns; it exits 0
  only when every step passes, and 1 for a refusal, a failed step, a crash or a run past
  240 s.
- `backfill-subscriptions.ts` gives existing accounts their trial rows
  ([billing](billing.md)). It is an owner-selected dry run by default, never gives
  returning deleted identities another trial, and skips test accounts entirely (not
  counted, no Stripe call). Its `--resync` mode, for after a release whose old and new
  revisions overlapped, re-reads every stored customer of a non-test account from Stripe
  through the webhook's read and compare-and-set (no event), with the same dry-run
  default, live-key guard, pacing and counts-only output; a failed read or second
  conflict counts as failed and exits nonzero.
