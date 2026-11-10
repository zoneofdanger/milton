# Self-hosting Milton

Milton keeps each person's writing: a cover sheet they write, and memos (an AI's first
draft, the final the person accepted and the tweaks between them). Connected AIs read
through `get_cover_sheet` and `get_report` and save through `create_memo`.
This directory contains the MCP server and the TPS page web app,
rendered with Hono JSX and Vite-built theme assets on Node 26 LTS. Neon Postgres stores memos, tweaks, the cover sheet and request receipts. The separate self-hosted auth service in `apps/auth` handles sign-in and authorization; this replacement requires the coordinated cutover below.

## Prerequisites

- Bun, using the version pinned in the repository's root `package.json`, and Node 26 LTS.
- A PostgreSQL database named `milton`, with TLS and separate owner/auth/app/MCP roles. Retain the managed auth schema during migration; no managed token or runtime fallback is accepted by this build.
- Native auth configuration for verified password/email, Google, GitHub and the selected mail sender. The auth service owns those credentials; app and MCP never receive them.
- A Google Cloud project for Cloud Run, Artifact Registry, Secret Manager and an HTTPS load balancer.
- An HTTPS origin for the browser app and an HTTPS URL ending in `/mcp` for AIs. They can share one hostname. The public service uses `app.meetmilton.com` and `mcp.meetmilton.com`; use your own addresses for your installation.

## Runtime and assets

Hono routes requests and renders escaped JSX on the server. Vite builds the shared
stylesheet and copies the theme assets; it does not bundle server secrets or add
browser scripts. Forms work with the existing strict CSP. Bun installs dependencies, builds and tests; production runs Node 26 LTS.

Hosted services use the role-specific Cloud Run entrypoint:
`src/cloud-run.ts` serves browser pages and an exact list of public assets with
`MILTON_SERVICE=app`, the protocol/store code with `MILTON_SERVICE=mcp`, or only auth's
two admission calls with `MILTON_SERVICE=admit`; any other value fails startup. The app and
MCP roles reject the other hostname and direct `run.app` requests and serve no
`/internal/` path. The MCP role needs no browser cookie secret. The admit role reads only
`AUTH_ISSUER`, `DATABASE_URL`, `AUTH_ADMISSION_SECRET`, `MILTON_TRIAL_FINGERPRINT_KEY` and
the Stripe settings; it is reached only through Cloud Run's invoker check (see the
[admission service](../docs/deploy/cloud.md#admission-service-milton-admit)).

Build the container from the repository root:

```sh
docker build --platform linux/amd64 -f server/Dockerfile -t milton-runtime .
```

The build minifies whitespace and syntax but keeps identifiers, so logged class names
and stack function names read as in source. It writes source maps beside the bundles;
the image leaves them out and runs without `--enable-source-maps`, since logs carry no
stacks and loading the maps slows startup. Locally,
`node --enable-source-maps server/dist/cloud-run.js` maps stacks to `server/src`.

Cloud Run listens on `0.0.0.0:$PORT`. SIGTERM stops accepting requests and allows up
to eight seconds to finish.

For dotenvx, mount an encrypted file and set `MILTON_ENCRYPTED_ENV_FILE` on Cloud Run.
Supply the matching `DOTENV_PRIVATE_KEY` separately through platform secret storage.
The file is the only payload option. Missing or invalid decryption fails closed. Existing platform
environment values take precedence. Without a payload file, the runtime
uses its environment directly, supporting local development and staged migration.
Keep encrypted release payloads private and versioned, and keep private keys out of
images, logs and git. The app holds opaque local sessions and one-use login state in an app-only schema. MCP cannot read them. Every app request checks the original native session and immutable binding; no cached positive authority is accepted.
Nonexportable platform secrets must not be exported through an application route.

## Configure first-party auth

The exact hosted issuer is `https://auth.meetmilton.com/api/auth`. Auth hosts login,
consent, password recovery, method linking and session management. App `/login` starts
a maintained `openid-client` code/S256/state/nonce flow with `openid profile email`,
no resource and no offline access. The owner-provisioned confidential client uses
`client_secret_post`, exact `/auth/callback` and `/auth/logged-out` app URLs, no default
MCP resource, and fixed-client RP logout. App never handles passwords or native cookies.

App sessions have an absolute one-hour maximum, bounded by the native identity-only
opaque token. Renewal starts a new flow through native SSO; it does not extend the old
session. App cookies are Secure, HttpOnly, SameSite=Lax and host-only in HTTPS hosting.
A real native outage returns 503; invalid proof or a spent callback refuses. A callback
with an uncertain exchange outcome must be recovered through a new login, not replayed.

Auth makes an authenticated, bounded `POST /internal/auth/admit` handoff to the
`milton-admit` service containing exact
issuer/subject/continuation, verified email and mandatory native `verifiedIdentities`
(Google/GitHub stable IDs; `[]` for password-only). App owns account/trial/billing admission.
Native validation precedes this handoff. Ownership is exact issuer+subject, never email
or those eligibility fingerprints. See [auth operations](../apps/auth/README.md#live-authority-admission-and-lifecycle);
the applied cutover procedure is in git history (`git show 492b96a:server/deploy/README.md`).

## Environment variables

Set these in the runtime's platform configuration or dotenvx payload before deploying. Keep credentials in secret storage or ignored environment files.

| Name                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                   | The browser app's absolute HTTPS origin, without a path, query, or fragment.                                                                                                                                                                                                                                                                                                                                                                               |
| `MCP_RESOURCE`                 | The exact public MCP resource URL, ending in `/mcp`. Tokens must include this resource in their audience.                                                                                                                                                                                                                                                                                                                                                  |
| `AUTH_ISSUER`                  | The exact native issuer, without a trailing slash; hosted: `https://auth.meetmilton.com/api/auth`. App uses verified discovery and fixed native endpoints; MCP uses `/jwks`.                                                                                                                                                                                                                                                                               |
| `AUTH_APP_CLIENT_ID`           | App only. Owner-provisioned fixed OIDC client ID.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AUTH_APP_CLIENT_SECRET`       | App only. Native-hashed confidential client secret, at least 32 characters; never a browser value.                                                                                                                                                                                                                                                                                                                                                         |
| `AUTH_ADMISSION_SECRET`        | Admit and auth only. At least 32 characters; authenticates native admission, never MCP. The app no longer reads it.                                                                                                                                                                                                                                                                                                                                        |
| `MILTON_TRIAL_FINGERPRINT_KEY` | App and admit only. Dedicated stable key, at least 32 characters, provisioned by the owner and checked against durable eligibility policy; independent of cookies/native encryption.                                                                                                                                                                                                                                                                       |
| `DATABASE_URL`                 | The TLS connection string for the `milton` database. App uses `milton_app_runtime`; MCP uses `milton_mcp_runtime`; auth uses its own role and URL. No runtime owns objects or inherits a writing/owner role.                                                                                                                                                                                                                                               |
| `MILTON_SUPPORT_EMAIL`         | Optional. The support address the account pages give; `support@meetmilton.com` when unset. The MCP address pages show is `MCP_RESOURCE`.                                                                                                                                                                                                                                                                                                                   |
| `STRIPE_SECRET_KEY`            | App and admit services only (admit starts sign-in's trial). The restricted Stripe API key for customers, subscriptions, Checkout and the billing portal. All three unset: the billing routes answer 503, sign-in starts no Stripe trial, the gate allows those accounts, and deleting an account with a Stripe customer refuses. Any one set means all three must be valid, or the app fails at startup; on admit, key and price come together or neither. |
| `STRIPE_WEBHOOK_SECRET`        | App service only; admit never reads it. The signing secret of the Stripe endpoint for `POST /billing/webhook`.                                                                                                                                                                                                                                                                                                                                             |
| `STRIPE_PRICE_ID`              | App and admit services only. The one recurring price sign-in's trial and Checkout subscribe to.                                                                                                                                                                                                                                                                                                                                                            |

Saves are model-free: Milton stores the exact text the AI sends and calls no
model on any read or save, so it needs no model credential, project or budget. The
runtime no longer reads `MILTON_GEMINI_*` or `MILTON_MODEL_*_BUDGET_USD`;
`MILTON_GLOBAL_SPEND_POLICY` or any `MILTON_SPEND_*` or `RESEND_API_KEY` setting either.
0022 dropped the SQL spend policy and readiness columns and 0023 the spend ledgers.
Saves reserve nothing; 0026 dropped `save_requests.reserved_micros`.

Use separate Neon branches and matching environment settings for development and previews. Redeploy after changing runtime configuration.

## Install and migrate

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd server build
```

Put the database connection string under `DATABASE_URL` in the ignored `server/.dev.vars` file. Then, from `server/`:

```sh
bun run db:migrate
```

This command explicitly reads `.dev.vars`, unless a release sets `MILTON_OWNER_DATABASE_URL` to the owner connection, which it then uses instead. It does not use `.env.local` or an inherited `DATABASE_URL`. It checks the database name and owner role, then applies pending migrations and records them in the Drizzle journal. Rerunning it applies only migrations that have not completed. Run one migration process at a time.

`drizzle/0000_baseline.sql` creates the original 14 tables,
the instruction-position sequence, seven guard functions and triggers, the `milton_runtime`
role and its grants/default privileges, and the singleton `store_config` seed. Authenticated native admission creates or finds the exact identity's account; a new account starts with an empty cover sheet and no memos.
Fresh installs apply every migration in `drizzle/` in order, with the owner files through
015 between `0012` and `0013` (005 grants on tables 0013 drops; 015 runs first, as in the
release).
`0012_memos` adds the memo, kind, tweak, citation, served-report, cover sheet and Keep
memos tables, and owner file `migrations/014-memos-roles.sql` grants them (see "Runtime
role"). `0013_drop_old_writing` drops the tables of the writing that memos replaced (cards,
samples, kinds, accepted changes, the guide tables), their sequence and the eight functions
only they used, and deletes the old store's save receipts (it keeps every receipt the memo
code wrote, so memo-era replays still return their outcome); owner file
`migrations/015-drop-guide-roles.sql`, applied just before it, drops the cluster-level
`milton_guide_worker` and `milton_guide_runtime` roles. After 0013, `005-app-roles.sql`
is never rerun.
`0014_drop_source_hash` drops `save_requests.source_hash`, which nothing reads or writes,
and leaves `save_request_hashes` checking `input_hash` alone.
Reads take no lock and invoke no model; a report read records which tweaks it served.

The baseline requires an empty database; direct baseline use on a populated old database
refuses. Older revisions are unsupported. The one-time owner transition production used
for its 0033 schema has been deleted; it is in git history, with the hosting runbook's cleanup
record (`git show 492b96a:server/deploy/README.md`).

Historical migrations, snapshots, rollback scripts and pre-steps are removed. Use the
normal `bun run db:generate` for later schema changes; add any required guard SQL to the
generated migration. Migration timestamps must strictly increase. Run one migrator at a
time. DDL and journal writes commit together; for an uncertain command outcome inspect
the actual schema and journal before retrying. Take the required pre-migration snapshot;
there is no reverse SQL that recreates the retired subsystem. Production applied this
cleanup on 2026-11-04; the hosting runbook at commit 492b96a records the snapshot,
baseline journal and preservation checks.

CI runs `bun scripts/check-migrations.ts` on every pull request, against the merge base
with `origin/main` (without it, as in a clone that never fetched main, it checks only
the lock and journal and says so):

- A new migration in `drizzle/`, `migrations/` or `apps/auth/migrations/` is numbered
  above main's highest in its track, with a number of its own; the Drizzle journal's
  idx and tag run without gaps and its `when` values strictly increase.
- `scripts/released-migrations.sha256` locks every migration file and Drizzle snapshot.
  Never edit, rename or remove one on main; add a new migration. Lock a new one with
  `bun scripts/check-migrations.ts --update` and commit the manifest with it.
- A new migration that drops, truncates or renames a table, column, view, schema, type
  (attribute or enum value) or function carries a line `-- code-stopped-by: #NN`
  naming the merged PR that stopped all code using it, and ships only after that code
  is released. Index, sequence, trigger and constraint drops and renames do not need
  it. Comments and string literals are skipped. Dynamic SQL (a `DO` block or
  `EXECUTE`, also inside a function or procedure body) cannot be read, so it needs that
  line or `-- no-drop-or-rename: <reason>`, as does a function, procedure, `DO` or
  `EXECUTE` body that itself drops, truncates or renames one of those; a plain function
  body, a trigger's `EXECUTE FUNCTION` and `GRANT EXECUTE` pass.

`test/deletion-inventory.test.ts` applies all three tracks to an empty PGlite and fails
on any text, character, JSON, bytea, tsvector, XML or enum column (or array, domain or
composite holding one), in a table or materialized view, not classified in
[docs/deletion-inventory.txt](../docs/deletion-inventory.txt) as deleted by account
deletion, hidden (kept, never served), retained (tied to no account, so deletion cannot
remove it, such as anonymous client registrations) or not personal, with a reason.

## Deploy

For Cloud Run, build and publish the container, then use separate app and MCP
service manifests. Follow [the release procedure](../docs/deploy/releases.md) for scoped secrets,
ingress, hostname routing, certificate verification and rollback. The container
includes the Vite-built CSS, fonts and favicons. Keep the previous runtime artifact
and secret versions; never roll back memo data with a hosting release.

Check `/health` on both canonical deployments and open `/login` on the browser app
origin. Sign in once before connecting an AI. Preserve Cloud Run revisions,
pinned images and numeric secret versions for recovery; never replace newer source
or report data when changing a runtime release. The old Vercel app/MCP project is retired.

## The first user

Every successful social sign-in creates or finds a Milton account; there is no admission setting and no account-count cap.

The first sign-in starts with an empty cover sheet and no memos. The browser shows the TPS page; connected AIs save memos and the person's cover sheet lines.

## Connect an AI

Add your configured `MCP_RESOURCE` URL as a remote HTTP MCP server. Complete
browser sign-in and consent. Connect Milton. Ask “did you get that memo?”
“Did you get the memo?” works too.

The server instructions (the `get_cover_sheet` description points to them) guide
the AI to reread the cover sheet for this request, even after an earlier read,
read `get_report` for the task, and confirm only after success; empty results, errors and
access failures must be reported honestly. Quoting or discussing the phrase does not
invoke it. This is AI
guidance, not a text listener or a guarantee that every client will call the tool.
Clients may need to reconnect to load updated guidance. To refresh tool schemas without
one, each AI's (account and OAuth client) first tool call that a server process
serves carries `notifications/tools/list_changed` on that call's response stream, ahead
of the result, and so does every `get_report` refused for a missing intent. The server is
stateless and has no open stream to push on, so a connected client hears of a release at
its next call; the set of announced AIs is per process, in memory, and cleared at
10,000, so a client may refresh again after a restart or on another instance.

Exactly three tools are exposed:

| Tool                             | Contract                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_cover_sheet()`              | Returns `{text, version, memos, tweaks, keep_memos, is_empty}`: the cover sheet, its integer version (0 before any; `cover_sheet.expected_version` fences on it), memo and tweak counts, the Keep memos switch, and whether the account has no cover sheet and no memos. While empty, `setup` carries the first-setup script. No model call, no write.                                                  |
| `get_report({intent})`           | `intent` is `{situation, medium, audience, purpose, kind_id?}`. Returns `{report_id, text, is_empty, examples, tweaks, kinds}`: the cover sheet, the best-matching finals as examples, then the tweaks those memos cite (see "Memos and reports"). Without a well-formed intent it refuses with `invalid_input`, saying what to send. It records the served tweak ids under `report_id`; no model call. |
| `create_memo({request_id, ...})` | Exactly one of `memo` (with an optional `report_id`), `cover_sheet`, `forget_memos` or `memo_context`, with a UUID for the logical request.                                                                                                                                                                                                                                                             |

`create_memo` returns `saved`, `unchanged`, `conflict`, or `failed`, with the request ID.
`saved` confirms a committed write; a saved memo's result carries `memo` (its id, tier,
kind, rounds, change and tweaks) and `receipt`, the one line the AI tells the person.
`unchanged` confirms no write: that memo, line or context is already on file. Reuse the
exact same arguments to recover an uncertain request; its receipt returns the original
outcome. Reusing an ID with different arguments is rejected. A `conflict` is a stale
cover sheet version and returns the current version and text: reread and send a new
request. No blind retry.

Every error says what to do next in the result itself, so error handling never depends
on the server instructions reaching the model. Each error result (and each MCP HTTP
refusal body: invalid token, scope, rate and busy limits, oversized request, outage)
keeps its `error` and `message` and adds `code`, the same stable code (`version_conflict`
for a stale-version `conflict`, which has no `error`), and `next: {action, text}`. A
scope refusal also carries `required_permission` (`read`, or `read_write` for a save):
what the attempted action needed, which its `next` names.
`action` is one of `retry` (repeat the identical call, a save with its request ID),
`reread` (read the cover sheet or report again, then save with a new request ID),
`fix_input` (correct the arguments), `ask_user` (the fix needs the person's approval or
choice) and `tell_user` (stop and tell the person); `text` is the one-line step, such as
giving the subscription link once without retrying. The mapping is one table,
`nextSteps` in `src/mcp-outcomes.ts`, and a test checks that every code in the source has
an entry. The SDK's plain-text argument refusals become the same JSON body with
`invalid_arguments` and the SDK's text as `message`.

A save runs in one transaction under the account lock, so a concurrent save of the
same request waits and then replays; there is no pending state. Account gates (trial
access) answer without a receipt, so the same request can succeed once the gate
opens. Every outcome decided after them writes the receipt with that outcome in the
same transaction, whether a cover sheet conflict, `request_too_large` or a refusal such as `invalid_kind`,
`invalid_tweak`, `memos_off` or `cover_sheet_limit`: the same request ID and input replay that
outcome, and different input under that ID is `request_id_reused`. When the commit's
acknowledgment is lost, Milton looks the receipt up under the account lock and returns
it; with no receipt nothing was written and the store error stands. Only when that
lookup fails too is the answer `save_outcome_unknown`: repeat the same request.

A malformed save (the schema, or a memo whose parts don't fit together) is refused
before any database work and writes no receipt. Milton runs no model and rewrites
nothing; the memo, cover sheet, forget and context contracts are under "Memos and
reports" below, and each behavior is a line in
[how Milton works](../docs/how-milton-works.md).

The AI offers setup once when the account is empty. The served script in
`src/store/setup.ts` helps with a real task first and keeps its accepted final as a
memo, offers to keep a few pieces the person pastes as final-only memos (their own
writing only, never automated, forwarded or other people's text), offers to start the
cover sheet in their words, and offers the standing instruction separately. Setup never
reads an inbox, imports anything or blocks a writing task. Milton cannot inspect
another AI's memory and does not guarantee AIs follow its instructions.

For clients that drop instructions, server info (`serverInfo.description`, MCP's
`Implementation.description`) carries one line of at most 120 characters, tested: Milton
holds the person's writing voice, and before writing or editing for them the AI
reads `get_cover_sheet`, then the matching `get_report`.

Usage guidance travels in four places: server `instructions` during MCP
initialization, descriptions in `tools/list`, descriptions on the save input
fields, and the `next` step on every error result. Connection instructions explain
the read workflow, when to keep a memo, first-draft fidelity, tweaks, the receipt line,
cover sheet routing, forget and setup, and point to `next` for errors; tool metadata
explains when to use each tool and the save fields (what a memo may hold, the cover
sheet change, forget, context correction and the request ID), field descriptions explain
the version fence and same-request retry rules, and error results say how to recover. Both
instruction variants stay under 3,500 characters, well inside the 4,096 at which Claude
Code truncates; a test enforces this and that no error handling is left in them.
The empty web page also provides a user-invoked setup prompt. No extra setup tool or
prompt capability is required.

The SDK client check confirms that connection instructions reach the client.
It does not prove a particular host includes them in model context or that its
AI follows them. Validate a real setup/save/read flow per supported client;
do not infer adherence from successful MCP discovery alone.

MCP accepts only the pinned EdDSA `at+jwt` access profile with exact issuer, required
MCP audience (plus native's fixed implicit UserInfo audience for `openid`), canonical
`client_id=azp`, supported scopes and immutable binding/incarnation/generation. It refuses
ID/session JWTs and unsupported confirmation/DPoP. Every call independently checks live
native SQL status. Read grants list two tools; write grants list three. All reads require
`milton:read`; `create_memo` requires read+write even on a direct call. A Bearer value starting with `mk_` is instead a connection key the
person created in the app: stored as a SHA-256 of its secret and bound to the native
subject, incarnation and security generation of the fresh session that created it. Every
call checks the key and native `connection_key_status` (native 007) live: revoked, expired,
closed-account, malformed and natively stale keys (after recovery, a security change or a
begun deletion) all get the invalid-token 401. Read keys list two tools and read-and-save
keys three. Before any database access a process remembers unknown key ids for 60 seconds,
limits each source (the client address Google's load balancer appends to `X-Forwarded-For`,
never the client-supplied first entry) to 5 key lookups, refilled at 10 a minute, with
successes charged a tenth (then 429 with `Retry-After`), and to 3 concurrent key lookups
(then 429 with `Retry-After: 1`), and allows 8 concurrent key lookups in all (then 503 with `Retry-After`). Limits are per instance. Read-only setup explains
reconnecting for saves rather than offering an unavailable save.

App `/account/security` takes the person to native method/password/session management.
Disconnect and deletion use durable original-incarnation operations. Refusal commits
before cleanup; reconnect/recreation cannot change an earlier operation's targets.
Deletion requires exact confirmation, live authoritative native freshness and current
verified-identity fingerprint retention. Stripe cancellation commits before writing
erasure; native bounded cleanup is last. Native refusal and the progress billing reads
commit together; once they do, billing links no Stripe customer for the account (one
Stripe made for a refused link and linked nowhere is deleted, best effort, a failure
only logged), checkout expires a session it opened, best effort, when it finds the
deletion afterwards (finished or not: the lifecycle row outlives the erase), and the erase first ends any customer still linked. A deletion
that begins after checkout's last read still deletes the customer; whether Stripe then
refuses to complete that open session is not verified at Stripe. An incomplete operation stays retryable and is
never presented as deleted. Logout ends this browser's local and native session while
leaving offline AIs connected.

## Local development and checks

Use isolated configuration and disposable data, never inherited production env or secrets.
The app/MCP dev server defaults to port 3001; check that a port is free before starting.
Native browser integration requires canonical auth/app origins and TLS; the explicit local
rehearsal below dispatches those requests in-process without DNS or external requests.

```sh
bun --no-env-file server/scripts/check-auth-integration.ts
bun run --cwd server check-types
bun --no-env-file test server/test
```

The explicit rehearsal builds actual server/native product modules with Bun, executes
Node26 and creates its own PostgreSQL18 cluster on 55623 with distinct TLS/SCRAM runtime
credentials. It checks the dispatched ports 20201–20204 too and refuses occupied ports.
Set `PG_BIN` to PostgreSQL's bin directory where needed. It removes only its own cluster,
TLS files and bundle. No external social/mail/Stripe calls occur. Protocol unit tests use
PGlite/doubles and are not a substitute for this command or real-browser acceptance.
The combined rehearsal leaves zod external to avoid Bun's combined-bundle initialization
cycle; installed declared dependencies are required. Production bundle/container closure
must also be checked independently.

Root global checks are types, `bun test` and `bun run format:check`; CI also runs this
rehearsal and the apps/auth integration suite on every pull request. The release
coordinator owns actual cutover.

`test/served-budget.test.ts` reads the tool descriptions an SDK client is served, in
both connection modes, and keeps each one and their total under a stated character
budget (the 2026-11-08 sizes plus 10–15%); growing past it means raising the budget
in that file, deliberately.

## Store, history, and limits

`src/store/save.ts` runs each save in one transaction: it takes the account lock,
replays a known request, checks the trial gate, makes the one change behind a
savepoint, and writes the receipt with its outcome. A refusal rolls back to the
savepoint and its receipt stores it; a transient database failure rolls back the whole
save, receipt included. A receipt keeps the input hash and the outcome (which can hold
a memo's kind and tweaks or the cover sheet's text), is written once and is immutable.
A crashed request commits nothing and leaves no receipt. Words are stored exactly as
sent; invalid Unicode and NUL are refused before a driver can replace them. No read or
save invokes a model.

| Limit                              | Bound                                                         |
| ---------------------------------- | ------------------------------------------------------------- |
| Request body                       | 256 KiB before parsing (`MAX_REQUEST_BYTES` in `src/http.ts`) |
| A final or first draft             | 256 KiB UTF-8                                                 |
| A final served as an example       | 128 KiB UTF-8 (larger ones are kept, never served)            |
| Cover sheet                        | 1,500 characters; an AI adds lines of at most 300             |
| Summary / tweak                    | 200 characters each, one line                                 |
| Audience, purpose / kind label     | 100 / 60 characters, one line                                 |
| Tweaks per memo / memos per forget | 10 / 100                                                      |

These bounds are fixed in code and the schema. `store_config.limits_json` is still
validated on every MCP call and sign-in (invalid limits refuse them), but no memo bound
reads it.

There is no daily call or save allowance. Each admitted tool call appends one
`usage_calls` row (account, time, tool) alongside its work; the reply waits for it at
most 250 ms, and failures are logged by code only (`src/store/usage.ts`). The row's
foreign key cascades from `users`. Rows are kept 90 days: the auth maintenance job
deletes older ones in bounded batches through `public.prune_usage_calls` (Drizzle `0008`),
never a request. `0008` also dropped `usage_daily` and the stored `daily_calls` key, the
retired daily allowance's leftovers.

`users.test_account` (Drizzle `0009`, default false) marks the fictional account the
daily end-to-end check uses (`e2e@milton-test.invalid`; see [the end-to-end check](../docs/deploy/e2e.md)). Only
the owner sets it. Usage numbers and every metric or count of accounts, calls, saves or
memos exclude test accounts: join `users` and filter `NOT u.test_account`. The
canonical usage count:

```sql
SELECT c.tool, count(*) AS calls
FROM usage_calls c JOIN users u ON u.id = c.user_id
WHERE NOT u.test_account AND c.at >= now() - interval '30 days'
GROUP BY c.tool ORDER BY c.tool;
```

Accounts: `SELECT count(*) FROM users WHERE status = 'active' AND NOT test_account;`.
Test accounts are permanently exempt from trials and billing, while trials stay on for
everyone else: their access never depends on a Stripe trial or customer. Each path checks
`test_account` explicitly, not only the absent trial row: the gate reads a test account as
early access whatever row it holds, so an ended status never closes it; sign-in's
`ensureSubscription` starts nothing for it; checkout and the portal answer 409; account
creation, the backfill and the returning-identity cancellation never give it a row or a
status; the webhook never writes its row; and no trial notice is offered. So no path
creates a Stripe customer for one. Operational checks that size a table
for a migration (such as `0008`'s size gate) count every row, test rows included.
There are no public archive/restore exemptions or history controls.
Retained history has no cap.

The website shows the TPS page, escapes its text and serves no browser JavaScript, from
one read per page view (`src/store/tps.ts`). Every
page preloads the shared Geist font and the Latin JetBrains Mono subset (the full
master loads only for other characters); the theme uses
`font-display: optional` to avoid a late font swap.
`/download` returns `TPS.md`: the cover sheet, the tweaks with counts, and every memo's
final grouped by medium, newest first. First drafts are not in it.

## Memos and reports

A memo (`memos`) keeps the final word for word and, when the AI still has it, the first
draft exactly as first shown (`first_draft_state` `kept`; `missing` when the AI sent
`first_draft_missing`; `none` for writing the person gave). With a first draft, `mode`
(`draft` or `edit`) and `rounds` are required; without one, the memo is final-only and
takes neither, nor tweaks. Each memo also holds a one-line summary, medium, optional
audience, purpose and kind (`memo_kinds`, per account, labels unique in any letter
case), the AI that saved it, the `report_id` of the read before the draft with the
tweak ids that report served, a change score and a tier. A save whose final and first
draft are already on file is `unchanged`. With Keep memos off (`memo_settings`; no row
means on), a memo with a first draft is refused with `memos_off`; final-only memos
still save.

The tier is set at save: final-only and edit memos are `own` ("your words"); drafted
memos are `steered` when the final differs from the first draft and `untouched` when it
equals it; with the first draft missing, `steered` when rounds is above 0, else
`untouched`. The change score (`src/store/score.ts`) is normalized token Levenshtein from
the first draft to the final over the longer token count, computed only for a kept
first draft and left NULL when the differing middle exceeds 20 million token pairs.

Tweaks (`tweaks`) are one line of at most 200 characters, sent with the memo only when
its final differs from its first draft. `{tweak_id}` reuses one of the account's
tweaks; `{text}` is normalized (NFC, lower case, collapsed spaces, trailing
punctuation dropped) and reuses an exact match (`norm`, unique per account), or is
added. `tweak_citations` holds one row per memo and tweak, and a tweak's count is its
citations. Forgetting a memo deletes its citations and any tweak left with none.

`get_report` ranks every memo (`src/store/memos.ts`) by requested kind, medium match,
word overlap of purpose and audience, tier, `ts_rank` of the situation against the
stored search vector of summary, purpose, audience and final, recency, then id.
Examples fill by rank within 32 KiB, skipping a block that doesn't fit, always serving
the top one, never serving untouched finals or finals over 128 KiB, and serving at most
3 steered finals. Tweaks come from the 10 best-ranked memos that cite any, by their best
memo's rank, then citation count, at most 10. The text prints `# Cover sheet`,
`# Examples` and `# Your tweaks`; with no example and no tweak it is `is_empty` and ends
with a fixed line telling the AI not to claim to know the person's voice. Each read
inserts a `served_reports` row with its id and served tweak ids.

The cover sheet (`cover_sheets`) is one text per account, at most 1,500 characters,
with every change appended as a version recording whether an AI or the person made it.
An AI's `cover_sheet` change carries `expected_version` and adds one line or removes one
exact line; it can't empty the cover sheet. The TPS page's form rewrites the whole text
under the same fence and may empty it.

`memo_context` replaces a memo's medium, summary, audience and purpose (omitted optional
fields clear) and optionally its kind; a memo's words never change. `forget_memos`
deletes up to 100 memos. The TPS page can also forget one memo, delete all memos (with
every tweak and kind, not the cover sheet), delete or reword a tweak (a reword keeps its
id and citations and refuses a wording another tweak has) and set Keep memos. Account
deletion cascades every memo table.

### Trials and billing (0012 groundwork, now live)

Trials are **off by default** in a new database (`store_config.trials_enabled=false`);
production has had trials and billing on since 2026-11-04 ([Stripe operations](../docs/deploy/stripe.md)).
The price is **USD $5.01/month**, one plan, no per-AI fees, set in Stripe and
named by `STRIPE_PRICE_ID`. Signed-in `/billing/checkout` and `/billing/portal`,
the Stripe webhook (0027) and the trial gate are implemented, and Stripe owns the trial.
The rest of this section describes the 0012 groundwork; where it differs,
`docs/how-milton-works.md` is current. The trial notice and the `subscription_required`
refusal link to the signed-in app home, whose banner holds the button. Existing early
access must not acquire a payment gate implicitly.

With trials on, a new account gets a `trial_accounts` row at sign-up, and
`scripts/backfill-subscriptions.ts` gives existing accounts theirs. An account without a
row reads as early access.
The account-creation transaction writes the row with the new Milton account's
`created_at` as `started_at`, which nothing reads; Stripe's `trial_end` ends the trial.
An enrolled account can expire without ever saving preferences. No start-trigger
explanation is shown in the product. Store only Stripe's ids, status and dates and a
reminder milestone; no preference bodies or payment details enter these records. Account deletion cascades.

Every MCP tool may attach a separate `notice` object to a successful result in the
last seven days and last day. Atomic account-wide claims offer each milestone at
most once across AIs and tools; returning during the last day skips
the earlier reminder. A lost response or timed-out notice lookup can lose that
reminder. Delivery does not establish display or acknowledgment. Lookup is bounded
to one second, with short database lock/statement limits, and never turns a
confirmed save into failure. The website banner does not consume MCP reminders.
Report text, version, downloads and saved receipts contain no billing notices.

Expired unsubscribed accounts receive a tool error `subscription_required` with
`retryable:false` and the signed-in app home as the one link in its message, as the
instructions say. This is not an
authentication failure or an empty successful report. New saves are checked under
the account lock, in the transaction that would publish them. Exact replay still
recovers an already accepted receipt. Web view/download remains available.

With billing configured, no new approval lands until the account has a subscription:
The authenticated native admission handoff starts the trial first, and a Stripe failure stops it with a retryable 503; an account whose deletion has begun gets a 410, which native turns into a final 403 `account_deleting` on sign-in, consent and explicit linking alike. An approval the native provider
already holds refreshes without any Milton page, so existing accounts depend on the
backfill. The signed Stripe
webhook keeps `subscription_status` and the dates current; the next request rechecks
access, so reconnecting an AI is unnecessary. These fields are
not writable through any MCP/browser input. The gate reads neither `started_at` nor
`paid_through`, which stay in place until a later migration. Subscribing early keeps
the trial: an account in a trial goes to the Stripe portal, where a card takes effect at
`trial_end`. Stripe's retry settings, retention duration, the existing-user transition
and paid allowances still require selected policies.

### Runtime role

The writing baseline's historical `milton_runtime` grants remain for rollback history;
the selected auth replacement uses separate NOINHERIT auth/app/MCP login roles with
explicit grants, no owner/group membership, DDL or TEMP path. `migrations/005-app-roles.sql`
is owner-reviewed preparation, not a blanket production revocation. App-only credentials
live in `milton_app`, outside public writing default grants. App cannot read native
credentials/keys; MCP cannot read either native secrets or app credentials. Auth cannot
read writing, billing or app storage. The immutable user-ID column permits the UPDATE
privilege PostgreSQL requires for row locks without permitting ownership changes.

Run `MILTON_SERVICE=app` or `mcp` with the corresponding private `DATABASE_URL` and
`bun --no-env-file server/scripts/check-runtime-role.ts`. This audits actual role
membership/ownership, DDL/TEMP, native table and lifecycle privileges. Inspect PUBLIC
views/functions/default privileges against the real retained schema before cutover too.

Connection keys (`connection_keys`, Drizzle `0004`) get no legacy-group grants.
The owner applies `migrations/006-connection-keys-roles.sql` after `005-app-roles.sql`:
app may read every column except `secret_hash`, insert, and set `revoked_at`; MCP may
read and set `last_used_at` only. No runtime can change a key's binding columns. Native
`007-connection-key-status` grants `connection_key_status` EXECUTE to MCP and app only.
Rerunning 006 converges.

Usage rows (`usage_calls`, Drizzle `0007`) get no legacy-group grants either. The owner
applies `migrations/009-usage-calls-roles.sql` after `0007` and before code that records
usage: MCP may only insert; app gets nothing (erasure cascades as the table owner).
`0007` also moves the six writer guard triggers' account lock from `FOR UPDATE` to
`FOR NO KEY UPDATE` (each otherwise unchanged), so no save waits on a usage row's
foreign-key check.
Rerunning 009 converges. Rollback is the pre-migration snapshot.

Usage retention (Drizzle `0008`) adds `public.prune_usage_calls(batch)`, a SECURITY
DEFINER function owned by the table owner with a fixed `pg_catalog, pg_temp` search path,
EXECUTE revoked from PUBLIC. The owner applies `migrations/010-usage-retention-roles.sql`
after `0008`: only `milton_auth_owner`, the auth maintenance job's role, may execute it,
with USAGE on `public` to resolve its name and no privilege on any writing table. No
runtime may run it. Rerunning 010 converges. Rollback is the pre-migration snapshot.

Test accounts (Drizzle `0009`) add `users.test_account`. The owner applies
`migrations/011-test-account-roles.sql` right after `0009`: app's table-wide INSERT on
`users` becomes INSERT on `id`, `status` and `created_at`, what it could insert before,
so with app and MCP UPDATE on `id` only (005) and nothing for auth or the guide, no
runtime login can set the column; the owner alone marks an account. Rerun 011 after any
rerun of 005, which restores table-wide INSERT. The legacy `milton_runtime` group's
table-wide grants (baseline) still cover the column; its `milton_app` login is unused.
Rerunning 011 converges. Rollback is the pre-migration snapshot.

The Stripe revision (Drizzle `0010`) adds `trial_accounts.stripe_revision bigint NOT NULL
DEFAULT 0`, a catalog change with no rewrite and no grant file: app's table-wide
`SELECT, INSERT, UPDATE` on `trial_accounts` (005) covers it and MCP's column list leaves it
out. Every write Milton's code makes of the Stripe state advances it, so checkout's live read and the webhook can
read Stripe with no transaction open and write only over an unchanged revision. Code that
reads it fails every checkout sync and webhook without the column, so apply `0010` before
releasing it; older code never names it. Rollback is the pre-migration snapshot.

Server timeouts live on the runtime logins, because Neon's proxy and pooler drop the
`statement_timeout`/`lock_timeout` a client passes at connect (the pools still pass them,
which plain PostgreSQL applies). As the privileged owner, `migrations/007-role-timeouts.up.sql`
sets, in database `milton` only, 20 s statement and 10 s lock limits for
`milton_app_runtime` and `milton_mcp_runtime` (the values in `src/store/database.ts`) and
a 5 s statement limit for `milton_auth_runtime` (`apps/auth`'s value; it sets no lock
limit). Owner, delegate, legacy and guide roles get none. `check-runtime-role.ts`
requires the app/MCP settings. A setting reaches only sessions that start after it.
Rollback is the pre-migration snapshot.

Memo tables (Drizzle `0012`) get no legacy-group grants. The owner applies
`migrations/014-memos-roles.sql` after `0012` and `005-app-roles.sql`, before code that
reads memos: MCP may insert, read and delete memos and update only their context
columns; insert and read kinds, served reports and cover sheet versions; insert, read and
delete tweaks and citations; and read the Keep memos switch. App may read and delete
memos, kinds, citations and tweaks, reword tweaks, append cover sheet versions and set
the switch. Neither runtime can change a memo's words. Rerunning 014 converges.
Rollback is the pre-migration snapshot.

Native auth mail now uses committed encrypted jobs/no-op receipts before generic public acceptance. No provider call occurs during an auth request; the separately selected auth-only `node deliver.js --apply` command drains bounded leased work using the original native target and exact message. App/MCP receive no mail payload/table/function privileges. [Auth operations](../apps/auth/README.md#bounded-mail-delivery-and-retention) describe uncertain503 recovery, retry/retention bounds, key recovery and disabled job preparation. Native migrations run through007. Old inline-send writers remain unsafe for public fallback; select a compatible fixed self-hosted revision/forward fix. Retained disabled managed sign-in schema/data/backups require separately selected cleanup and are disclosed in the candidate privacy/intake wording.
