# Self-hosting Milton

Milton maintains internal memos containing writing rules and approved samples.
Connected assistants submit changes through `create_memo` and read the
cover sheet and reports through `get_cover_sheet`, `get_report` and `list_reports`.
This directory contains the MCP server and current-report web app,
rendered with Hono JSX and Vite-built theme assets on Node 26 LTS. Neon Postgres stores instruction cards, samples, internal
history and request receipts. The separate self-hosted auth service in `apps/auth` handles sign-in and authorization; this replacement requires the coordinated cutover below.

## Prerequisites

- Bun, using the version pinned in the repository's root `package.json`, and Node 26 LTS.
- A PostgreSQL database named `milton`, with TLS and separate owner/auth/app/MCP roles. Retain the managed auth schema during migration; no managed token or runtime fallback is accepted by this build.
- Native auth configuration for verified password/email, Google, GitHub and the selected mail sender. The auth service owns those credentials; app and MCP never receive them.
- A Google Cloud project for Cloud Run, Artifact Registry, Secret Manager and an HTTPS load balancer.
- An HTTPS origin for the browser app and an HTTPS URL ending in `/mcp` for assistants. They can share one hostname. The public service uses `app.meetmilton.com` and `mcp.meetmilton.com`; use your own addresses for your installation.

## Runtime and assets

Hono routes requests and renders escaped JSX on the server. Vite builds the shared
stylesheet and copies the theme assets; it does not bundle server secrets or add
browser scripts. Forms work with the existing strict CSP. Bun installs dependencies, builds and tests; production runs Node 26 LTS.

Hosted services use the role-specific Cloud Run entrypoint:
`src/cloud-run.ts` serves browser pages and an exact list of public assets with
`MILTON_SERVICE=app` or the protocol/store code with `MILTON_SERVICE=mcp`; any other
value fails startup. Each role rejects the other hostname and direct `run.app`
requests. The MCP role needs no browser cookie secret.

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

Auth makes an authenticated, bounded `POST /internal/auth/admit` handoff containing exact
issuer/subject/continuation, verified email and mandatory native `verifiedIdentities`
(Google/GitHub stable IDs; `[]` for password-only). App owns account/trial/billing admission.
Native validation precedes this handoff. Ownership is exact issuer+subject, never email
or those eligibility fingerprints. See [auth operations](../apps/auth/README.md#live-authority-admission-and-lifecycle);
the applied cutover procedure is in git history (`git show 492b96a:server/deploy/README.md`).

## Environment variables

Set these in the runtime's platform configuration or dotenvx payload before deploying. Keep credentials in secret storage or ignored environment files.

| Name                           | Meaning                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                   | The browser app's absolute HTTPS origin, without a path, query, or fragment.                                                                                                                                                                                                                                                                                   |
| `MCP_RESOURCE`                 | The exact public MCP resource URL, ending in `/mcp`. Tokens must include this resource in their audience.                                                                                                                                                                                                                                                      |
| `AUTH_ISSUER`                  | The exact native issuer, without a trailing slash; hosted: `https://auth.meetmilton.com/api/auth`. App uses verified discovery and fixed native endpoints; MCP uses `/jwks`.                                                                                                                                                                                   |
| `AUTH_APP_CLIENT_ID`           | App only. Owner-provisioned fixed OIDC client ID.                                                                                                                                                                                                                                                                                                              |
| `AUTH_APP_CLIENT_SECRET`       | App only. Native-hashed confidential client secret, at least 32 characters; never a browser value.                                                                                                                                                                                                                                                             |
| `AUTH_ADMISSION_SECRET`        | App and auth only. At least 32 characters; authenticates native admission, never MCP.                                                                                                                                                                                                                                                                          |
| `MILTON_TRIAL_FINGERPRINT_KEY` | App only. Dedicated stable key, at least 32 characters, provisioned by the owner and checked against durable eligibility policy; independent of cookies/native encryption.                                                                                                                                                                                     |
| `DATABASE_URL`                 | The TLS connection string for the `milton` database. App uses `milton_app_runtime`; MCP uses `milton_mcp_runtime`; auth uses its own role and URL. No runtime owns objects or inherits a writing/owner role.                                                                                                                                                   |
| `MILTON_SUPPORT_EMAIL`         | Optional. The support address the account pages give; `support@meetmilton.com` when unset. The MCP address pages show is `MCP_RESOURCE`.                                                                                                                                                                                                                       |
| `STRIPE_SECRET_KEY`            | App service only. The restricted Stripe API key for customers, subscriptions, Checkout and the billing portal. All three unset: the billing routes answer 503, sign-in starts no Stripe trial, the gate allows those accounts, and deleting an account with a Stripe customer refuses. Any one set means all three must be valid, or the app fails at startup. |
| `STRIPE_WEBHOOK_SECRET`        | App service only. The signing secret of the Stripe endpoint for `POST /billing/webhook`.                                                                                                                                                                                                                                                                       |
| `STRIPE_PRICE_ID`              | App service only. The one recurring price sign-in's trial and Checkout subscribe to.                                                                                                                                                                                                                                                                           |

Saves are model-free: Milton stores the exact text the assistant sends and calls no
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
role and its grants/default privileges, and the singleton `store_config` seed. Authenticated native admission creates or finds the exact identity's account; a new account reads empty documents.
Reads assemble cards and samples, take no lock, write nothing and invoke no model.
Fresh installs also apply `0001_sample_context` and `0002_sample_versions`; the latter
adds `sample_versions`, leaving 15 tables defined in `src/store/schema.ts`.

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

## Deploy

For Cloud Run, build and publish the container, then use separate app and MCP
service manifests. Follow [the hosting runbook](deploy/README.md) for scoped secrets,
ingress, hostname routing, certificate verification and rollback. The container
includes the Vite-built CSS, fonts and favicons. Keep the previous runtime artifact
and secret versions; never roll back memo data with a hosting release.

Check `/health` on both canonical deployments and open `/login` on the browser app
origin. Sign in once before connecting an assistant. Preserve Cloud Run revisions,
pinned images and numeric secret versions for recovery; never replace newer source
or report data when changing a runtime release. The old Vercel app/MCP project is retired.

## The first user

Every successful social sign-in creates or finds a Milton account; there is no admission setting and no account-count cap.

The first sign-in starts with an empty cover sheet, empty reports and no active rules. Existing instruction bodies and card history are preserved. The browser views the current report; connected assistants submit user-directed changes.

## Connect an assistant

Add your configured `MCP_RESOURCE` URL as a remote HTTP MCP server. Complete
browser sign-in and consent. Connect Milton. Ask “did you get that memo?”
“Did you get the memo?” works too.

The server instructions (the `get_cover_sheet` description points to them) guide
the assistant to reread the cover sheet for this request, even after an earlier read,
fetch the report whose situation matches, apply relevant conditions and exceptions, and confirm
only after success. Empty accounts retain first-setup approval; errors and access
failures must be reported honestly. Quoting or discussing the phrase does not invoke
it, and the cue grants no save or session-capture consent. This is assistant
guidance, not a text listener or a guarantee that every client will call the tool.
Clients may need to reconnect to load updated guidance. To refresh tool schemas without
one, each assistant's (account and OAuth client) first tool call that a server process
serves carries `notifications/tools/list_changed` on that call's response stream, ahead
of the result, and so does every `get_report` refused for a missing intent. The server is
stateless and has no open stream to push on, so a connected client hears of a release at
its next call; the set of announced assistants is per process, in memory, and cleared at
10,000, so a client may refresh again after a restart or on another instance.

Exactly four tools are exposed:

| Tool                                                     | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_cover_sheet()`                                      | Returns `{text, version, is_empty, reports}`: the rules true of all writing, the save fence, whether the whole account is empty, and the index of five reports with their situations; only while the whole account has no rules or samples, `setup` offers onboarding. No model call, no write.                                                                                                                                                                                                                                                                                           |
| `get_report({report_id, intent})`                        | One of `email`, `chat`, `post`, `document` (`doc` accepted), `speech`, and a required `intent`: `{situation, kind_id?, context?}`. Returns `{report_id, text, version, is_empty, kinds, samples, selection}`: heading, when line, the eight samples that best fit the intent, best first, then rules; see below for `samples`. Without a well-formed intent it refuses with `invalid_input`, saying what to send. Only while the report has no rules or samples, `setup` carries optional help. Existing samples are usable with zero rules; setup never blocks an explicit writing task. |
| `list_reports()`                                         | All five reports as `{reports: [{report_id, text, is_empty, samples, setup?}], version}`, without the cover sheet, each with its newest eight samples; a report without rules or samples has a one-line optional `setup` pointer to `get_report`.                                                                                                                                                                                                                                                                                                                                         |
| `create_memo({text, request_id, expected_version, ...})` | An exact save with at least one of `rules`, `exact_edits`, `moves`, `sample`, `sample_context`, `retire_samples`; `text` states its purpose. UUID for the logical request and version from the cover sheet.                                                                                                                                                                                                                                                                                                                                                                               |

`create_memo` returns `saved`, `unchanged`, `conflict`, or `failed`,
with the request ID and relevant version/error.
`saved` confirms a committed write; `unchanged` confirms no write. Neither alone
proves the requested meaning is on file: reread the cover sheet or report and compare it
with the requested change before confirming that. Reuse the exact same
arguments to recover an uncertain request; its receipt returns the original
outcome. That receipt's version may be
older than the current report. Reusing an ID with different arguments is rejected.
For a conflict, reread the cover sheet and reconsider a new request. No blind retry.

Every error says what to do next in the result itself, so error handling never depends
on the server instructions reaching the model. Each error result (and each MCP HTTP
refusal body: invalid token, scope, rate and busy limits, oversized request, outage)
keeps its `error` and `message` and adds `code`, the same stable code (`version_conflict`
for a stale-version `conflict`, which has no `error`), and `next: {action, text}`.
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
same transaction, whether a version conflict, `request_too_large`, `memo_body_limit`,
or an edit, move, sample or size refusal: the same request ID and input replay that
outcome, and different input under that ID is `request_id_reused`. When the commit's
acknowledgment is lost, Milton looks the receipt up under the account lock and returns
it; with no receipt nothing was written and the store error stands. Only when that
lookup fails too is the answer `save_outcome_unknown`: repeat the same request.

Every save needs at least one structured field; a save with only `text` is refused
with `invalid_input`: "Name the report and send the rule's text in rules." `text` is
the stated purpose for every save: recorded with the accepted change, never stored or
stored as a rule. Milton runs no model, rewrites nothing and reserves no budget.

New rules go in `rules`, 1-100 entries of `{report, text}`. `report` is one of the five
reports (`doc` accepted) or `cover`. Each entry becomes one new card holding `text`
byte for byte; its description is the first non-blank line, trimmed and cut to the
description cap. Each body must fit the body limit and contain no Markdown heading line
(`card_heading`). There is no count limit on rules (0021 removed it; archived cards
are kept, so a count capped an account's lifetime saves). An
entry that prints identically to an active card in the same report (compared as
printed, so `Be concise.` matches a stored `- Be concise.`), or to an earlier entry in
the request, is skipped; when nothing else changes the save returns
`unchanged` and charges nothing. Duplicates by meaning are not detected. The assistant
picks the report and the wording; a wrong report is fixable with `moves`. A rule
that would be stored starting with `Baseline: `, new or after an exact edit or move,
fails the save with `baseline_unknown`: only the retired setup picks used that prefix.
An existing Baseline rule can still be retired or edited to drop the prefix; rules
without the prefix are unaffected.

Corrections and removals of existing rules use `exact_edits`, a nonempty array of
`{before, after}` (1-500). Copy each nonempty `before` verbatim from a current rule as printed,
with or without its `- ` bullet; `after`
is the exact replacement, including an empty string for removal. Each anchor must
occur once across all printed rules (each card as `- ` plus its text) and fit within
one card; it is then applied to the stored bytes, and a copied bullet in `after` is not
doubled. Moves resolve the same way. Missing, repeated
or overlapping anchors return `failed` with `edit_conflict`, without partial edits;
reread the report and choose unambiguous spans. All matches use the original snapshot,
so a later edit cannot target text produced by an earlier one. Both strings must
be valid Unicode, within the existing body limit, and contain no NUL. The complete
request must fit the 256 KiB request bound.

Some text cannot be targeted exactly: identical card bodies have no unique anchor,
and a span cannot cross memo boundaries. Refuse those edits instead of selecting an
arbitrary occurrence. The `rules` duplicate skip stops new identical bodies; existing
ones need an administrative fix.

The caller authors every byte and remains responsible for its meaning and user
authorization. All other source bytes and descriptions stay exact; an edit whose
`before` is a whole rule and whose `after` is empty retires it, retaining its internal
history. An unchanged replacement leaves history and the version alone. This avoids server-side paraphrasing; it does not certify
caller edits, and nothing detects a correction sent as a new rule that contradicts an
old one. It does not change first-setup and capture approval rules.

Structured fields resolve against one snapshot and commit together or not at all;
`sample_context` cannot combine with `sample` or `retire_samples`. `moves` is `[{before, report}]`
(1-500): `before` is verbatim text identifying one rule, as for `exact_edits`, and
`report` is a report or `cover`. A move to the rule's current place is a no-op; an
unresolvable or repeated move, or a move of a rule the same save removes, fails with
`move_conflict`. `sample` is `{report, kind_id | new_kind, context, text, sample_id?}`.
Context is one strict object with `version: 1` and a useful one-line `summary`
(1–200 characters). Optional known dimensions are `purposes` (1–8 distinct values),
`medium`, `audience` (relationship, role, familiarity, expertise, group), `interaction`,
`scope` (`unit: "whole" | "excerpt"`, optional `role` only for excerpts), `language`
and `register`. Vocabulary values are nonblank single lines of at most 60 characters;
new purposes and media need no schema change. Unknown dimensions stay absent;
unknown keys, empty audience objects, duplicate purposes and invalid scope are refused.
Use generic situations and roles, never private identities or project facts.
`kind_id` must name a kind in that report. A `new_kind` whose label already exists
there, in any letter case, files under that kind (including a kind whose samples are
all retired, which reads no longer list); otherwise it creates one. Omit `sample_id`
for a new example; supply the stable ID of an active sample to append a complete
approved revision of its text, context and report/kind. `replaces` is no longer accepted.
`retire_samples` lists 1-500 active stable sample IDs, each retired by appending an
inactive snapshot with reason `removed`. Revision is distinct from retirement;
nothing retires a sample automatically. A new example inserts nothing only when an
active example has identical body bytes, report/kind and complete JSON context.
Different context can justify a separate example. Revisions compare only to their
own identity and never merge identities, even when another example matches.
An identical revision appends nothing; a save that changes nothing returns
`unchanged` and charges nothing.
Sample errors fail with `sample_conflict`. A `saved` result carries
`samples_retired: [{id, reason}]` whenever a sample was retired, and replay returns
it unchanged. A report read serves up to eight active samples (see "Sample context and ranking"), and report reads list each served sample as `{id, kind_id, kind, context,
revision, date, match?}` in served order;
kind labels never appear in report text. The separate `kinds` index contains
`{kind_id, kind}` for every distinct personal kind with an active sample in this report,
in ascending `kind_id` order. It is computed from the full tenant/report snapshot before
the eight-sample cut, independently of intent. It has no sample bodies and excludes
other accounts/reports, empty kinds and kinds with only retired samples. Use these IDs
to request an older otherwise unserved kind or to reuse it on a sample save.

`sample_context: {report, sample_id, context, kind_id?}` corrects an active sample
after approval of the complete replacement context and any classification change.
Omitting optional context dimensions deliberately clears them; omitting `kind_id`
keeps its classification. A supplied kind must already belong to that person's report.
Body, stable ID and original creation timestamp stay unchanged. A distinct correction
appends a complete immutable sample revision and advances its approval time, recency
and account version, even outside the served eight. Identical context/classification
is `unchanged`; retries use the exact original request ID and input. Foreign, retired
or wrong-report samples fail with `sample_conflict`. Reclassification can leave
identical active examples in one kind without merging or retiring either identity.
Correction and rule changes are atomic together on success or refusal.

The assistant offers setup once when the whole account is empty;
other empty reports offer help only on request. The served script in
`src/store/setup.ts` preserves existing guidance and invites pasted-writing cleanup
first by default; explicit requests to add examples go directly to that conversation.
Older examples match the report and remain optional. Finding candidates requires
the person's request and already authorized access.
It excludes automated, forwarded and third-party text, shows exact proposed
samples with private details replaced by placeholders, and requires explicit
retention approval before each exact save and readback. Setup authorizes the
conversation, not inbox access, account changes, import or unseen saves.
After an approved draft or edit, the sample approval step offers once to retain the
exact body and context, excluding the change list. Another writing task is offered
only if wanted. The shared entry prompt displays both edits and older examples as
placeholder-safe proposals before exact retention approval.
Skipping examples never blocks writing, and samples are usable with zero rules.
The standing instruction is offered separately with consent; an actual successful
read, not setup completion, verifies the connection. Rules remain supported when
explicitly requested; one example does not imply a standing rule. An active
Baseline rule from the retired setup picks still adds the fixed explanatory note to
the cover sheet. Milton cannot inspect another
assistant's memory and does not guarantee assistants follow its instructions.

Two offers follow from writing. When the person approves a draft or edit,
the assistant offers once to save it as a sample under the report that
applies. On EVERY sample save it displays the exact text and proposed useful non-private
context together; a no is final for that draft and nothing is saved silently. One yes
to that proposal is sufficient; unchanged approved metadata needs no second approval.
Ask again only if text or context changes, including redaction. Praise or permission to
send is not retention approval. When the person makes the same correction twice, the
assistant proposes one short rule and files it only on approval; a single
correction is a one-off. Both run through `create_memo` with ordinary approval.

Usage guidance travels in four places: server `instructions` during MCP
initialization, descriptions in `tools/list`, descriptions on the save input
fields, and the `next` step on every error result. Connection instructions explain
the shared read/setup/save workflow and consent rules and point to `next` for errors;
tool metadata explains when to use each tool and the save fields (rules, samples,
version, request ID and what capture excludes), field descriptions explain the opaque
version and same-request retry rules, and error results say how to recover. Both
instruction variants stay under 3,500 characters, well inside the 4,096 at which Claude
Code truncates; a test enforces this and that no error handling is left in them.
The empty web page also provides a user-invoked setup prompt. No extra setup tool or
prompt capability is required.

Session capture is an optional assistant workflow using these same tools.
The person must explicitly opt in in the current conversation; connection consent,
first-draft approval, report content and quoted examples do not enable it. At task
completion, the assistant compares explicit reusable standing rules with the current
cover sheet and reports and submits only genuine changes, preserving scope and conditions.
It excludes one-off requests, project facts, inferred preferences, transcripts,
secrets and other people's private details. An empty account still needs complete-draft
approval. Opt-out stops future capture without deleting existing rules or
undoing a save already submitted. Capture consent itself is never filed as a rule.
Copyable on/off prompts are in the root README.

No new tool, schema, consent flag, hook or background worker is involved. The server
does not receive the conversation or enforce its opt-in; the connected assistant
must follow that guidance and client tool approvals. MCP provides no guaranteed
session-end capture trigger. The workflow reuses normal version fencing, receipts,
and recovery rules. Cross-client missed instructions and incorrect saves
still need evaluation; successful SDK discovery proves guidance delivery only.

The SDK client check confirms that connection instructions reach the client.
It does not prove a particular host includes them in model context or that its
assistant follows them. Validate a real setup/save/read flow per supported client;
do not infer adherence from successful MCP discovery alone.

MCP accepts only the pinned EdDSA `at+jwt` access profile with exact issuer, required
MCP audience (plus native's fixed implicit UserInfo audience for `openid`), canonical
`client_id=azp`, supported scopes and immutable binding/incarnation/generation. It refuses
ID/session JWTs and unsupported confirmation/DPoP. Every call independently checks live
native SQL status. Read grants list three tools; write grants list four. All reads require
`milton:read`; `create_memo` requires read+write even on a direct call. A scope grant never
approves memo text. A Bearer value starting with `mk_` is instead a connection key the
person created in the app: stored as a SHA-256 of its secret and bound to the native
subject, incarnation and security generation of the fresh session that created it. Every
call checks the key and native `connection_key_status` (native 007) live: revoked, expired,
closed-account, malformed and natively stale keys (after recovery, a security change or a
begun deletion) all get the invalid-token 401. Read keys list three tools and read-and-save
keys four. Before any database access a process remembers unknown key ids for 60 seconds,
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
erasure; native bounded cleanup is last. An incomplete operation stays retryable and is
never presented as deleted. Logout ends this browser's local and native session while
leaving offline assistants connected.

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

## Store, history, and limits

`src/store/save.ts` runs each save in one transaction: it takes the account lock,
replays a known request, checks the trial gate, snapshots all instruction-card heads,
resolves the save against that snapshot, writes, checks the assembled size limits,
and writes the receipt with its outcome. Exact edits and moves name existing
cards only through unique anchors; `rules` entries become new cards with
server-assigned IDs. Omitted cards keep their exact bodies, descriptions and versions.
The cover sheet and reports are assembled from the final stored active bodies and
samples (see below). Bodies are not trimmed, rewritten or truncated, apart from
one stored leading `- ` that the printed bullet replaces;
descriptions are metadata, not an additional instruction source. Card versions,
samples and the receipt commit together. Stale or conflicting saves cannot
partially publish.

Internal `instruction_card_versions` are append-only. Nothing assembled is
stored: the version is a fingerprint of the assembled documents. There is
no report content history. Receipts keep input hashes and bounded outcomes, not raw
submitted text or copies of reports. A receipt is written once, with its
outcome, and is immutable. A crashed request commits nothing and leaves no receipt.

Saves anchor only in current active cards, never archived versions or a prior snapshot.
Invalid Unicode
in submitted text is rejected before a driver can replace it. The database validates
identity and size limits. If a report or the full text would exceed its bound, the
save is refused with `tps_body_limit` and every change it made rolls back; the
receipt stores the refusal, but no source change commits. No read or
save invokes a model.

| Limit                      | Default                                                       |
| -------------------------- | ------------------------------------------------------------- |
| Rule or sample text        | 128 KiB UTF-8 (`body_bytes`)                                  |
| Cover sheet or report body | 256 KiB UTF-8 each (`report_body_bytes`)                      |
| Description/reason         | 500 UTF-8 bytes each                                          |
| Request body               | 256 KiB before parsing (`MAX_REQUEST_BYTES` in `src/http.ts`) |

There is no daily call or save allowance. Each admitted tool call appends one
`usage_calls` row (account, time, tool) alongside its work; the reply waits for it at
most 250 ms, and failures are logged by code only (`src/store/usage.ts`). The row's
foreign key cascades from `users`. Rows are kept 90 days: the auth maintenance job
deletes older ones in bounded batches through `public.prune_usage_calls` (Drizzle `0008`),
never a request. `0008` also dropped `usage_daily` and the stored `daily_calls` key, the
retired daily allowance's leftovers.
There are no public archive/restore exemptions or history controls.
Retained history has no cap.

The website shows the current cover sheet and reports, escapes their text and serves no browser JavaScript.
It displays one bullet per complete active instruction card, preserving internal
line breaks and conditions and dropping one stored leading `- ` as assembly does,
from one read per page view. Every
page preloads the shared Geist font and the Latin JetBrains Mono subset (the full
master loads only for other characters); the theme uses
`font-display: optional` to avoid a late font swap.
`/download` returns the cover rules and every non-empty report, including all active
approved samples, as `TPS.md`. Old memo/history/recovery
routes return 404.

## Reports, samples and the cover sheet

A report is the unit of the assembled output. Every instruction-card version has a
`report`: one of `email`, `chat`, `post`, `document` or `speech`, or `cover`
for a rule that applies to all writing. Card identities keep their insertion order;
moving a card appends a version without changing its identity or position.

`samples` holds each stable tenant-scoped identity, original `created_at` and filing
`client_json`. `sample_versions` holds complete numbered snapshots: report/kind,
validated JSONB `context`, exact `body`, retirement state/reason, revision timestamp,
actor, request ID and backfill provenance. The latest revision alone is current;
reads select it before filtering out retirement. Guards keep identities and versions
immutable and permit sequential appends only while the account and sample are active.
Account hard deletion cascades both identities and revisions. Filing through
`create_memo` makes no model call and reserves no budget. Every example stays active
until explicit retirement; a report read serves eight. Body or metadata revisions
advance approval date and all sample recency ordering; original creation stays separate.

Assembly is deterministic and runs on read. Every rule prints as one bullet: `- `
followed by its stored body, with one stored leading `- ` (as the retired compiler
filed rules) dropped first, so rules from either era read alike. Known limitation: a
rule whose own text starts with `- ` (stored as sent) prints as a plain bullet, so a
reader cannot tell that dash is content. Stored cards are not
edited. The cover sheet is the cover-sheet rules joined by blank lines; the fixed
report index (one "when" line per report) travels beside it as data. Each report
prints `# Title`, its when line, selected active samples (a context line with
the date, then the body quoted with `>`), then its rules. MCP reads select eight samples,
ranked for the read's intent or else newest first; the web page shows the newest eight.
TPS.md includes all active samples, newest first. Both full texts are the cover sheet
plus every non-empty report. The web page lists each
sample by its exact context summary, readable approved dimensions and date.

A read takes the card heads, the active samples and the account's status in one
statement, without a transaction or lock, so a concurrent save shows whole or not at
all; it writes nothing. An assistant read adds the trial gate: two queries and no
database connection, where the read before 0031 opened a connection and a transaction
with the account lock and wrote a lagging snapshot. The version every
read returns and every save fences on is a fingerprint of what any read can serve:
SHA-256 of the user ID, the cover sheet, and each report's text (its newest eight) with
every active sample's stable ID, kind ID, kind label and revision, so
it is the same for every intent. The same cards and samples always give the same version, an empty
account included, and a save that changes what is served changes it. Versions from
before 0031 hashed a stored revision, so a client holding one conflicts once on its
next save (`conflict` with the current version), rereads and saves normally.

Each body has its own cap (`report_body_bytes`, 256 KB by default); the full text is
bounded at six bodies. Caps measure the printed text, bullets included. A save that
would exceed a cap is refused with `tps_body_limit` and nothing is truncated or
published. Reads are not rechecked: a read serves what is on file even above a cap
lowered since, and only the next save is refused. Rules saved before rules printed as
bullets can read up to two bytes per bare rule over the cap until the next save. Card text still cannot contain a Markdown
heading line (`card_heading`). Each `rules` entry names its card's report; since 0020
a card moves only through an explicit `moves` list.

## Filing moves and sample kinds

A card's report lives on each version (`instruction_card_versions.report`, NOT NULL,
one of the five reports or `cover`). NULL never
means the cover sheet. A move appends a version with the same description and body
(`details.kind` `move`); an edited and moved card gets one version carrying both.
A move changes the report a rule prints in, so it changes the version. A moved card
keeps its position.

`sample_kinds` holds immutable kinds: `(user_id, id, report, label)`, labels unique
per report by `lower(label)`, rows removable only with their account. Each
`sample_versions` snapshot references its identity through `(user_id, sample_id)`
and its kind through `(user_id, kind_id, report)`, so classification stays within the
tenant and the kind's report. Full `sample` revisions can correct report/kind together;
`sample_context` reclassifies within the current report. Retirement appends an
inactive copy of the exact current body/context/classification, with the retiring
`request_id` and revision timestamp. Retired identities cannot be revised or revived.
Current retirement uses `removed`; backfilled retired snapshots and old receipts
can retain `replaced` or `evicted`. Old replacement IDs and retirement dates/reasons
remain in backfill provenance rather than a current replacement-link column.

### Trials and billing (0012 groundwork, now live)

Trials are **off by default** in a new database (`store_config.trials_enabled=false`);
production has had trials and billing on since 2026-11-04 ([the hosting runbook](deploy/README.md)).
The price is **USD $5.01/month**, one plan, no per-assistant fees, set in Stripe and
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
most once across assistants and tools; returning during the last day skips
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
The authenticated native admission handoff starts the trial first, and a Stripe failure stops it with a retryable 503. An approval the native provider
already holds refreshes without any Milton page, so existing accounts depend on the
backfill. The signed Stripe
webhook keeps `subscription_status` and the dates current; the next request rechecks
access, so reconnecting an assistant is unnecessary. These fields are
not writable through any MCP/browser input. The gate reads neither `started_at` nor
`paid_through`, which stay in place until a later migration. Subscribing early keeps
the trial: an account in a trial goes to the Stripe portal, where a card takes effect at
`trial_end`. Stripe's retry settings, retention duration, the existing-user transition
and paid allowances still require selected policies.

### Durable accepted changes

Every successful `create_memo` change writes immutable internal provenance in the same
transaction as card history. (Records from the removed refinement Apply keep
their `refinement_apply` operation.) It preserves the exact submitted instruction or
exact edits, `rules` and stated purpose, actor, request ID, affected before/after card-version references, before/after source fingerprints
and versions, and transformation identity. It records only what Milton received, not a conversation
or proof of the human's full intent. Legacy missing request evidence is not reconstructed.
No-op and failed saves add no accepted-change record.
Replay adds no duplicate. New saves record transformation pipeline `exact:v1`.

Records live as long as internal history and are removed with account deletion.
There is no lifetime history cap; 0006 drops the generated payload byte fields it summed.

### Sample context and ranking

`get_report` requires `intent: {situation, kind_id?, context?}`. `situation` is one line
of at most 200 characters. `context` takes the optional dimensions described above,
without version or summary. An invalid, foreign or wrong-report kind returns
`invalid_kind`; reads never create a kind.

One snapshot reads the card heads and active tenant samples and computes `ts_rank`
against the stored search vector of summary and body, matching any situation word.
Selection within the requested report orders by requested-kind match, purpose overlap
count, exact supplied scalar dimension match count, full-text rank, latest revision timestamp descending,
then ID ascending. These are ordered tiers, without speculative weights. Up to eight
slots fill from broader examples when exact matches are sparse. `match` lists kind
match (when requested), overlapping purposes and matching dimension paths; `selection`
explains the fallback. Unknown scope stays unknown; excerpts do not establish whole-work
structure. Without intent (`list_reports`, the web page), selection stays newest eight.
The complete TPS.md export includes all active samples and useful approved context.

A missing/malformed intent returns `invalid_input` before the store is read; only the
missing-intent refusal recommends reconnecting a client without that field. Context
representation version describes the context format; each sample revision is a complete
body/context/classification/lifecycle snapshot and fences account saves, including
edits outside the served eight.

Migration `0001_sample_context` converts the old summary and audience/purpose/register
labels exactly into one JSONB context without inventing metadata. Forward migration
`0002_sample_versions` then maps linear replacement chains to root stable IDs and
preserves each known snapshot's body, context, classification and actor bytes. Legacy
IDs, creation/retirement dates, reasons, requests and context counters remain in revision
provenance; accepted-change evidence stays unchanged. Retired leaves remain inactive,
including consolidation without a successor. Earlier overwritten contexts and correction
times cannot be reconstructed and are explicitly marked unknown; backfilled revisions
count known snapshots, dated by known creation or leaf retirement times. Cycles,
branches and invalid tenant/report/lifecycle parents abort transactionally before
destructive changes. Applied baseline/context migrations remain unchanged.

The revision schema and API are incompatible with old runtimes. A separately authorized
cutover must close reads/writes, drain old instances, snapshot, apply the owner migration,
verify preservation and matching app/MCP code, then reopen ingress and verify canonical
reads. Production applied it on 2026-11-07; the procedure is in the hosting runbook at commit
492b96a (`git show 492b96a:server/deploy/README.md`).
No old runtime may serve the new schema. Reconnect assistants and reread current IDs
and the account version before saving. No compatibility layer or rollback artifact
is supplied. Implementation
and local fictional rehearsal do not authorize a production migration or deployment.

### Limits and save invariants

The byte caps above apply alongside 1-100 rules and up to 500
exact edits, moves and sample removals per save, with a 256 KiB request bound.
`sample_versions_body` allows 131072 bytes, `accepted_change_shape` allows 1,100 affected cards,
and `save_request_result` allows 65,536 bytes. The stored limits in use are `body_bytes`,
`description_bytes`, `reason_bytes` and `report_body_bytes`; any other stored key is
ignored.
There is no card count, daily call or save allowance, or lifetime history cap.

A save and its outcome receipt commit in one transaction. Every receipt holds an
outcome and refuses updates; a crash before commit leaves no receipt. Reads assemble
sources without storing a snapshot, and the fingerprint version fences saves.

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

Server timeouts live on the runtime logins, because Neon's proxy and pooler drop the
`statement_timeout`/`lock_timeout` a client passes at connect (the pools still pass them,
which plain PostgreSQL applies). As the privileged owner, `migrations/007-role-timeouts.up.sql`
sets, in database `milton` only, 20 s statement and 10 s lock limits for
`milton_app_runtime` and `milton_mcp_runtime` (the values in `src/store/database.ts`) and
a 5 s statement limit for `milton_auth_runtime` (`apps/auth`'s value; it sets no lock
limit). Owner, delegate, legacy and guide roles get none. `check-runtime-role.ts`
requires the app/MCP settings. A setting reaches only sessions that start after it.
Rollback is the pre-migration snapshot.

App and MCP read `sample_versions` and the guide state in `guide_accounts` and
`report_guides`; MCP appends to `samples` and `sample_versions` but cannot update
either, because migration `0002` makes every sample change an insert. Neither runtime
writes guide tables or reads `guide_spend`; the separate `milton_guide_worker`
capability is described in [the guide pilot runbook](deploy/guides.md).

Native auth mail now uses committed encrypted jobs/no-op receipts before generic public acceptance. No provider call occurs during an auth request; the separately selected auth-only `node deliver.js --apply` command drains bounded leased work using the original native target and exact message. App/MCP receive no mail payload/table/function privileges. [Auth operations](../apps/auth/README.md#bounded-mail-delivery-and-retention) describe uncertain503 recovery, retry/retention bounds, key recovery and disabled job preparation. Native migrations run through007. Old inline-send writers remain unsafe for public fallback; select a compatible fixed self-hosted revision/forward fix. Retained disabled managed sign-in schema/data/backups require separately selected cleanup and are disclosed in the candidate privacy/intake wording.
