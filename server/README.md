# Self-hosting Milton

This directory contains the MCP server and the TPS page web app, rendered with Hono JSX
and Vite-built theme assets on Node 26 LTS. Postgres stores memos, tweaks, the cover
sheet and request receipts. The self-hosted auth service in `apps/auth` handles sign-in
and authorization ([its README](../apps/auth/README.md)).

This file covers local setup and operation. How Milton behaves is in the concept files
under [docs/](../docs/), listed in [AGENTS.md](../AGENTS.md): start with
[memos](../docs/memos.md), [reports](../docs/reports.md), [mcp](../docs/mcp.md) and
[hosting](../docs/hosting.md). Releases follow [the hosting runbook](deploy/README.md).

## Prerequisites

- Bun, using the version pinned in the repository's root `package.json`, and Node 26 LTS.
- A PostgreSQL database named `milton`, with TLS and separate owner, auth, app and MCP
  roles ([database](../docs/database.md)). Retain the managed auth schema; no managed
  token or runtime fallback is accepted by this build.
- Native auth configuration for verified password/email, Google, GitHub and the selected
  mail sender. The auth service owns those credentials; app and MCP never receive them.
- A Google Cloud project for Cloud Run, Artifact Registry, Secret Manager and an HTTPS
  load balancer.
- An HTTPS origin for the browser app and an HTTPS URL ending in `/mcp` for AIs. They can
  share one hostname. The public service uses `app.meetmilton.com` and
  `mcp.meetmilton.com`; use your own addresses for your installation.

## Build and run

Build the container from the repository root:

```sh
docker build --platform linux/amd64 -f server/Dockerfile -t milton-runtime .
```

`MILTON_SERVICE` picks the app, MCP or admission role ([hosting](../docs/hosting.md)).
The build minifies whitespace and syntax but keeps identifiers, so logged class names and
stack function names read as in source. It writes source maps beside the bundles; the
image leaves them out and runs without `--enable-source-maps`, since logs carry no
stacks and loading the maps slows startup. Locally,
`node --enable-source-maps server/dist/cloud-run.js` maps stacks to `server/src`.

For dotenvx, mount an encrypted file and set `MILTON_ENCRYPTED_ENV_FILE` on Cloud Run.
Supply the matching `DOTENV_PRIVATE_KEY` separately through platform secret storage. The
file is the only payload option. Without a payload file, the runtime uses its environment
directly, which suits local development. Keep encrypted release payloads private and
versioned, and keep private keys out of images, logs and git. Nonexportable platform
secrets must not be exported through an application route.

## Configure first-party auth

The exact hosted issuer is `https://auth.meetmilton.com/api/auth`. Auth hosts login,
consent, password recovery, method linking and session management. App `/login` starts
the OIDC flow ([accounts](../docs/accounts.md)). Provision one owner-provisioned
confidential client for the app: `client_secret_post`, exact `/auth/callback` and
`/auth/logged-out` app URLs, no default MCP resource, and fixed-client RP logout. Auth
reaches the `milton-admit` service through Cloud Run's invoker check (see
[the hosting runbook](deploy/README.md#admission-service-milton-admit)).

## Environment variables

Set these in the runtime's platform configuration or dotenvx payload before deploying.
Keep credentials in secret storage or ignored environment files. Milton calls no model,
so it needs no model credential, project or budget.

| Name                           | Meaning                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MILTON_SERVICE`               | `app`, `mcp` or `admit`.                                                                                                                                                             |
| `APP_ORIGIN`                   | The browser app's absolute HTTPS origin, without a path, query, or fragment.                                                                                                         |
| `MCP_RESOURCE`                 | The exact public MCP resource URL, ending in `/mcp`. Tokens must include this resource in their audience. Pages show it as the connection address.                                   |
| `AUTH_ISSUER`                  | The exact native issuer, without a trailing slash; hosted: `https://auth.meetmilton.com/api/auth`. App uses verified discovery and fixed native endpoints; MCP uses `/jwks`.         |
| `AUTH_APP_CLIENT_ID`           | App only. Owner-provisioned fixed OIDC client ID.                                                                                                                                    |
| `AUTH_APP_CLIENT_SECRET`       | App only. Native-hashed confidential client secret, at least 32 characters; never a browser value.                                                                                   |
| `AUTH_ADMISSION_SECRET`        | Admit and auth only. At least 32 characters; authenticates native admission, never MCP.                                                                                              |
| `MILTON_TRIAL_FINGERPRINT_KEY` | App and admit only. Dedicated stable key, at least 32 characters, provisioned by the owner and checked against durable eligibility policy; independent of cookies/native encryption. |
| `DATABASE_URL`                 | The TLS connection string for the `milton` database. App uses `milton_app_runtime`; MCP uses `milton_mcp_runtime`; auth uses its own role and URL.                                   |
| `MILTON_SUPPORT_EMAIL`         | Optional. The support address the account pages give; `support@meetmilton.com` when unset.                                                                                           |
| `STRIPE_SECRET_KEY`            | App and admit only. The restricted Stripe API key for customers, subscriptions, Checkout and the billing portal ([billing](../docs/billing.md)).                                     |
| `STRIPE_WEBHOOK_SECRET`        | App only. The signing secret of the Stripe endpoint for `POST /billing/webhook`.                                                                                                     |
| `STRIPE_PRICE_ID`              | App and admit only. The one recurring price sign-in's trial and Checkout subscribe to.                                                                                               |

The three Stripe settings are all or nothing on the app; on admit, key and price come
together or neither. Use separate Neon branches and matching environment settings for
development and previews. Redeploy after changing runtime configuration.

## Install and migrate

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd server build
```

Put the database connection string under `DATABASE_URL` in the ignored
`server/.dev.vars` file. Then, from `server/`:

```sh
bun run db:migrate
```

This reads `.dev.vars`, unless a release sets `MILTON_OWNER_DATABASE_URL` to the owner
connection, which it then uses instead. It does not use `.env.local` or an inherited
`DATABASE_URL`. It checks the database name and owner role, then applies pending
migrations and records them in the Drizzle journal; rerunning it applies only migrations
that have not completed. Run one migration process at a time. Fresh installs need an
empty database; the order of the three migration tracks and the owner files is in
[database](../docs/database.md). Use `bun run db:generate` for later schema changes.

## Deploy

For Cloud Run, build and publish the container, then follow
[the hosting runbook](deploy/README.md) for scoped secrets, ingress, hostname routing,
certificate verification and rollback. The container includes the Vite-built CSS, fonts
and favicons. Keep the previous runtime artifact and secret versions; never roll back
memo data with a hosting release.

Check `/health` on both canonical deployments and open `/login` on the browser app
origin. Sign in once before connecting an AI.

## The first user

The first sign-in creates an account with an empty cover sheet and no memos
([accounts](../docs/accounts.md)). The browser shows the TPS page; connected AIs save
memos and the person's cover sheet lines.

## Connect an AI

Add your configured `MCP_RESOURCE` URL as a remote HTTP MCP server. Complete browser
sign-in and consent. Ask "Did you get the memo?" to check the connection reads
([memos](../docs/memos.md)). Clients may need to reconnect to load updated guidance.
Validate a real setup, save and read per supported client; do not infer adherence from
successful MCP discovery alone ([mcp](../docs/mcp.md)).

## Local development and checks

Use isolated configuration and disposable data, never inherited production env or
secrets. The app/MCP dev server defaults to port 3001; check that a port is free before
starting. Native browser integration requires canonical auth and app origins and TLS; the
explicit local rehearsal below dispatches those requests in-process without DNS or
external requests.

```sh
bun --no-env-file server/scripts/check-auth-integration.ts
bun run --cwd server check-types
bun --no-env-file test server/test
```

The rehearsal builds actual server and native product modules with Bun, executes Node 26
and creates its own PostgreSQL 18 cluster on 55623 with distinct TLS/SCRAM runtime
credentials. It checks the dispatched ports 20201 to 20204 too and refuses occupied
ports. Set `PG_BIN` to PostgreSQL's bin directory where needed. It removes only its own
cluster, TLS files and bundle. No external social, mail or Stripe calls occur. Protocol
unit tests use PGlite and doubles and are not a substitute for this command or
real-browser acceptance. The combined rehearsal leaves zod external to avoid Bun's
combined-bundle initialization cycle; installed declared dependencies are required.
Production bundle and container closure must also be checked independently. What CI runs
is in [checks](../docs/checks.md).

To audit a runtime role, run `MILTON_SERVICE=app` or `mcp` with the corresponding
private `DATABASE_URL` and `bun --no-env-file server/scripts/check-runtime-role.ts`. It
audits actual role membership and ownership, DDL/TEMP, native table and lifecycle
privileges. Inspect PUBLIC views, functions and default privileges against the real
retained schema too.

## Counting usage

Usage numbers and every metric or count of accounts, calls, saves or memos exclude test
accounts: join `users` and filter `NOT u.test_account`. The canonical usage count:

```sql
SELECT c.tool, count(*) AS calls
FROM usage_calls c JOIN users u ON u.id = c.user_id
WHERE NOT u.test_account AND c.at >= now() - interval '30 days'
GROUP BY c.tool ORDER BY c.tool;
```

Accounts: `SELECT count(*) FROM users WHERE status = 'active' AND NOT test_account;`.
Operational checks that size a table for a migration count every row, test rows
included.
