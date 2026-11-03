# Self-hosting Milton

Milton maintains internal memos containing writing rules and approved samples.
Connected assistants submit changes through `create_memo` and read the
cover sheet and reports through `get_cover_sheet`, `get_report` and `list_reports`.
This directory contains the MCP server and current-report web app,
rendered with Hono JSX and Vite-built theme assets on Node 26 LTS, with a separate scheduled spend-alert worker. Neon Postgres stores instruction cards, samples, internal
history, the current report snapshot and request receipts; Neon Auth handles sign-in and authorization.

## Prerequisites

- Bun, using the version pinned in the repository's root `package.json`, and Node 26 LTS.
- A Neon project with Auth and its OAuth provider plugin enabled. Create a Postgres database named `milton`. The migration and import commands require the `neondb_owner` role, and database connections require TLS.
- A Google OAuth app, a GitHub OAuth app, or both. Configure their credentials in Neon Auth for your branch.
- A Google Cloud project for Cloud Run, Artifact Registry, Secret Manager and an HTTPS load balancer.
- An HTTPS origin for the browser app and an HTTPS URL ending in `/mcp` for assistants. They can share one hostname. The public service uses `app.meetmilton.com` and `mcp.meetmilton.com`; use your own addresses for your installation.

## Runtime and assets

Hono routes requests and renders escaped JSX on the server. Vite builds the shared
stylesheet and copies the theme assets; it does not bundle server secrets or add
browser scripts. Forms work with the existing strict CSP. Bun installs dependencies, builds and tests; production runs Node 26 LTS.

`src/function.ts` is a local compatibility adapter; hosted services use the role-specific Cloud Run entrypoint.
`src/cloud-run.ts` serves browser pages and an exact public-asset allowlist with
`MILTON_SERVICE=app`, the protocol/store code with `MILTON_SERVICE=mcp`, or
the private spend-alert worker with `MILTON_SERVICE=worker`. App and MCP roles each reject
the other hostname and direct `run.app` requests. The MCP role needs no browser
cookie secret. The worker has no browser routes and must be protected by Cloud Run
IAM and internal ingress; its adapter relies on that platform authentication.

Build the container from the repository root:

```sh
docker build --platform linux/amd64 -f server/Dockerfile -t milton-runtime .
```

Cloud Run listens on `0.0.0.0:$PORT`. SIGTERM stops accepting requests and allows up
to eight seconds to finish.

For dotenvx, mount an encrypted file and set `MILTON_ENCRYPTED_ENV_FILE` on Cloud Run.
Supply the matching `DOTENV_PRIVATE_KEY` separately through platform secret storage.
The file is the only payload option; the retired inline `MILTON_ENCRYPTED_ENV`
value is refused. Missing or invalid decryption fails closed. Existing platform
environment values take precedence. Without a payload file, the runtime
uses its environment directly, supporting local development and staged migration.
Keep encrypted release payloads private and versioned, and keep private keys out of
images, logs and git. The app gets its own cookie-signing key; MCP and worker do not.
Milton discards the SDK's session-data cache and validates existing session tokens
with Neon, so a different cache-signing key does not replace the upstream session.
Nonexportable platform secrets must not be exported through an application route.

## Configure Neon Auth

Use the same branch's Auth settings and issuer throughout your installation.

For each social provider, copy the callback URL from its Neon Auth configuration into the Google or GitHub app. Its form is `{NEON_AUTH_BASE_URL}/callback/google` or `{NEON_AUTH_BASE_URL}/callback/github`. These callbacks belong to Neon, not to Milton's browser app. Save the provider's client ID and secret in Neon Auth.

Configure the OAuth provider plugin:

| Setting                             | Configuration                                                 |
| ----------------------------------- | ------------------------------------------------------------- |
| Login page URL                      | The browser app origin followed by `/login`                   |
| Consent page URL                    | The browser app origin followed by `/consent`                 |
| MCP server URL                      | The exact URL represented by `MCP_RESOURCE`, including `/mcp` |
| Client ID Metadata Documents (CIMD) | Enabled                                                       |
| Dynamic client registration (DCR)   | Enabled                                                       |
| Trusted origin                      | The exact browser app origin represented by `APP_ORIGIN`      |

Milton supplies the login and consent pages. Neon supplies authorization, token exchange, client registration, and signing keys. There is no separate MCP plugin to enable in Neon.

## Environment variables

Set these in the runtime's platform configuration or dotenvx payload before deploying. Keep credentials in secret storage or ignored environment files.

| Name                      | Meaning                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`              | The browser app's absolute HTTPS origin, without a path, query, or fragment.                                                                      |
| `MCP_RESOURCE`            | The exact public MCP resource URL, ending in `/mcp`. Tokens must include this resource in their audience.                                         |
| `NEON_AUTH_BASE_URL`      | The exact branch Auth URL copied from Neon, including its database and Auth path, without a trailing slash. It is also the expected token issuer. |
| `NEON_AUTH_COOKIE_SECRET` | A fresh random server-only secret of at least 32 characters for browser session cookies.                                                          |
| `DATABASE_URL`            | The TLS connection string for the `milton` database. Use the owner connection for migrations and imports.                                         |

Saves are model-free: Milton stores the exact text the assistant sends and calls no
model on any read or save, so it needs no model credential, project or budget. The
runtime no longer reads `MILTON_GEMINI_*` or `MILTON_MODEL_*_BUDGET_USD`;
`MILTON_GLOBAL_SPEND_POLICY` is no longer read either. The SQL policy in
`store_config` still gates memo-update admission (0014). Every claim reserves 0.

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

This command explicitly reads `.dev.vars`. It does not use `.env.local` or an inherited `DATABASE_URL`. It checks the database name and owner role, then applies pending migrations and records them in the Drizzle journal. Rerunning it applies only migrations that have not completed. Run one migration process at a time.

The migrations create the application tables defined in `src/store/schema.ts`.
Fresh installations start with sign-ups closed.

Migration `0006_compiled_memos.sql` adds the current report snapshot (`tps_reports`)
and durable save receipts. It preserves existing memos and their version history,
including content formerly stored under the legacy `vibes` name, which participates
as an ordinary internal memo. Since 0017 a read whose snapshot lags its sources
rebuilds it under the account lock (see below); reads never invoke a model. Empty
accounts read an empty cover sheet and empty reports.

There are no old tool aliases or compatibility mode. Apply the
migration before running this server, and refresh client tool discovery. The
migration runner and the disposable rehearsal test verify atomic DDL. For an
uncertain command outcome, inspect the actual schema and migration journal before
retrying; an interrupted connection does not prove rollback.

The offline rollback script `drizzle/rollback/0006_compiled_memos.sql` parks the two
new tables and receipt guard in `milton_rollback`, retaining their rows and all memo
history. The journal is retained. Re-forward with
`drizzle/rollback/0006_compiled_memos_reforward.sql`, not by deleting the journal
entry or rerunning the forward CREATE statements. Stop the application while
using these scripts. Historical migrations 0000–0005 and their inverses remain
unchanged; their legacy naming and recovery rules are not the current public API.

### Instruction-card upgrade (0008)

This is a coordinated offline migration, not a rolling mixed-writer upgrade. Disable
capture/review, stop and drain app/MCP writers and worker leases, then take a database
backup and counts/hashes of TPS, source history, receipts and gardening records. Apply
`0008_instruction_cards.sql` through the normal migration runner before starting the
matching app/MCP/worker code. Verify per-account TPS bytes, revision and source hash
are unchanged before reopening writes. This work does not itself authorize a live migration.

Each legacy memo, including archived/empty heads, becomes one stable card with the
same ID and full version history. Its text and timestamps are copied exactly; no
model call or speculative split occurs. 0008 also added the `memo_cards` membership
table; since 0017 assembly no longer reads it, and it remains as history only.

This expand phase retains the original memo history and a complete card-history copy.
Both copies count toward retained storage. Backfill does not discard history or fail
merely because the account crosses its ceiling, but subsequent ordinary writes are
refused until capacity is available. Check headroom before rollout. Later removal of
legacy copies requires a separate migration; it is not included here. The existing
count ceiling also bounds card identities, including archived ones.

Signup initialization (the empty `vibes` seed) is the only remaining legacy memo
write; it synchronizes only untouched one-card memos. Once cards are independently
edited, legacy writes/deletion refuse with
`card_legacy_conflict`; use the current `create_memo` path. No MCP tool or UI reads or
writes legacy memos.

`drizzle/rollback/0008_instruction_cards.sql` is an offline **pre-write rollback**.
It proves every card/history row is an unchanged legacy copy, refuses native card data,
changed grouping or new card-bound audit jobs, then removes only duplicate tables and
restores retained-byte accounting. TPS, original history, receipts and jobs are not
restored or overwritten. After native card activity, keep the schema and use a forward
fix. Never resume an old writer/observer against independently edited cards.

If rolling back a journaled migration, inspect the exact final Drizzle journal row
and remove only its 0008 hash/timestamp after the successful rollback, in the same
maintenance window. Re-forward using the normal runner after journal reconciliation;
never delete journal entries merely to resolve an uncertain migration outcome.

## Deploy

For Cloud Run, build and publish the container, then use separate app, MCP and worker
service manifests. Follow [the hosting runbook](deploy/README.md) for scoped secrets,
ingress, hostname routing, certificate verification and rollback. The container
includes the Vite-built CSS, fonts and favicons. Keep the previous runtime artifact
and secret versions; never roll back memo data with a hosting release.

Check `/health` on both canonical deployments and open `/login` on the browser app
origin. Finish admission before connecting an assistant. Preserve Cloud Run revisions,
pinned images and numeric secret versions for recovery; never replace newer source
or report data when changing a runtime release. The old Vercel app/MCP project is retired.

## Admit the first user

Neon sign-in and Milton admission are separate. With the default closed configuration, a successful social sign-in can create a Neon Auth user but end with “New Milton accounts are closed.” (`admission_refused`) in Milton. Existing admitted users can still sign in when new sign-ups are closed.

Choose one admission mode. Run the SQL in Neon's SQL editor against the `milton` database.

### Allow only yourself

For a private installation, use allow-list mode. After signing in once, copy your user ID from Neon Auth's Users list. It must be the Neon Auth user ID, not your email, Google or GitHub account ID, or Milton account ID. Replace `YOUR_NEON_AUTH_USER_ID` below:

```sql
UPDATE store_config
SET signup_mode = 'allowlist',
    allowed_identities_json = jsonb_build_array(
      jsonb_build_object(
        'provider', 'neon',
        'subject', 'YOUR_NEON_AUTH_USER_ID'
      )
    ),
    updated_at = now()
WHERE singleton = 1;
```

This replaces the allow-list with that one identity. To admit more people, include an object with `provider` and `subject` for each Neon Auth user. Return to `/login` after applying the update to finish admission.

### Allow new users

To accept anyone who can complete your configured social sign-in:

```sql
UPDATE store_config
SET signup_mode = 'open',
    updated_at = now()
WHERE singleton = 1;
```

You can apply this before anyone signs in. There is no account-count cap. Setting `signup_mode` back to `closed` stops new admissions without locking out existing users.

The first admitted sign-in starts with an empty cover sheet, empty reports and no active rules. Existing memo bodies and history are preserved. The browser views the current report; connected assistants submit user-directed changes.

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
Clients may need to reconnect to load updated guidance.

Exactly four tools are exposed:

| Tool                                                     | Contract                                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_cover_sheet({hook_event?})`                         | Returns `{text, version, is_empty, reports}`: the rules true of all writing, the save fence, whether the whole account is empty, and the index of five reports with their situations. No model call, no write. |
| `get_report({report_id})`                                | One of `email`, `chat`, `post`, `document` (`doc` accepted), `speech`. Returns `{report_id, text, version, is_empty, samples}`: heading, when line, samples newest first, then rules; see below for `samples`. |
| `list_reports()`                                         | All five reports as `{reports: [{report_id, text, is_empty, samples}], version}`, without the cover sheet.                                                                                                     |
| `create_memo({text, request_id, expected_version, ...})` | An exact save with at least one of `rules`, `exact_edits`, `moves`, `sample`, `retire_samples`; `text` states its purpose. UUID for the logical request and version from the cover sheet.                      |

`hook_event` on `get_cover_sheet` returns the cover sheet and report index in
`hookSpecificOutput.additionalContext` instead of the normal envelope. Supported
events are `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PostCompact` and
`PostToolUse`; client support differs. The [agent kit](../packages/agent-kit/README.md)
provides context replacement, local objective checks and correction preparation.
It cannot establish adherence or force unsupported clients to retrieve instructions.

`create_memo` returns `saved`, `unchanged`, `conflict`, `in_progress`, or `failed`,
with the request ID and relevant version/error. (`needs_clarification` appears only
in receipts saved before saves became model-free; their replay returns it unchanged.)
`saved` confirms a committed write; `unchanged` confirms no write. Neither alone
proves the requested meaning is on file: reread the cover sheet or report and compare it
with the requested change before confirming that. Reuse the exact same
arguments to recover an uncertain request; a completed receipt returns its original
outcome without another memo-update charge. That receipt's version may be
older than the current report. Reusing an ID with different arguments is rejected.
For a conflict, reread the cover sheet and reconsider a new request. No blind retry.

Replay does not depend on the phase. Account gates checked before a claim (trial
access, the memo-update allowance) answer without a receipt, so the same request can
succeed once the gate opens. Every outcome decided after them completes a receipt,
whether found while claiming (a version conflict, `request_too_large`,
`memo_body_limit`) or while applying (a conflict, an edit, move, sample or size
refusal, or a trial that ended mid-save): the same request ID and input replay that
outcome, and different input under that ID is `request_id_reused`.

Every save needs at least one structured field; a save with only `text` is refused
with `invalid_input`: "Name the report and send the rule's text in rules." `text` is
the stated purpose for every save: recorded with the accepted change, never stored or
stored as a rule. Milton runs no model, rewrites nothing and reserves no budget.

New rules go in `rules`, 1-20 entries of `{report, text}`. `report` is one of the five
reports (`doc` accepted) or `cover`. Each entry becomes one new card holding `text`
byte for byte; its description is the first non-blank line, trimmed and cut to the
description cap. Each body must fit the body limit and contain no Markdown heading line
(`card_heading`). There is no count limit on rules (0021 removed it; archived cards
are kept, so a count capped an account's lifetime saves). An
entry that prints identically to an active card in the same report (compared as
printed, so `Be concise.` matches a stored `- Be concise.`), or to an earlier entry in
the request, is skipped; when nothing else changes the save returns
`unchanged` and charges nothing. Duplicates by meaning are not detected. The assistant
picks the report and the wording; a wrong report is fixable with `moves`.

Corrections and removals of existing rules use `exact_edits`, a nonempty array of
`{before, after}`. Copy each nonempty `before` verbatim from a current rule as printed,
with or without its `- ` bullet; `after`
is the exact replacement, including an empty string for removal. Each anchor must
occur once across all printed rules (each card as `- ` plus its text) and fit within
one card; it is then applied to the stored bytes, and a copied bullet in `after` is not
doubled. Moves resolve the same way. Missing, repeated
or overlapping anchors return `failed` with `edit_conflict`, without partial edits;
reread the report and choose unambiguous spans. All matches use the original snapshot,
so a later edit cannot target text produced by an earlier one. Both strings must
be valid Unicode, within the existing body limit, and contain no NUL. The complete
request must fit the 64 KiB request bound.

Some text cannot be targeted exactly: identical card bodies have no unique anchor,
and a span cannot cross memo boundaries. Refuse those edits instead of selecting an
arbitrary occurrence. The `rules` duplicate skip stops new identical bodies; existing
ones need an administrative fix.

The caller authors every byte and remains responsible for its meaning and user
authorization. All other source bytes and descriptions stay exact; an edit whose
`before` is a whole rule and whose `after` is empty retires it, retaining its internal
history. When the snapshot already matches its sources, an unchanged replacement leaves
history and the version alone. This avoids server-side paraphrasing; it does not certify
caller edits, and nothing detects a correction sent as a new rule that contradicts an
old one. It does not change first-setup and capture approval rules.

All structured fields can combine in one save: every operation resolves against one
snapshot and commits together or not at all. `moves` is `[{before, report}]`
(1-100): `before` is verbatim text identifying one rule, as for `exact_edits`, and
`report` is a report or `cover`. A move to the rule's current place is a no-op; an
unresolvable or repeated move, or a move of a rule the same save removes, fails with
`move_conflict`. `sample` is `{report, kind_id | new_kind, context, text, replaces?}`.
`kind_id` must name a kind in that report. A `new_kind` whose label already exists
there, in any letter case, files under that kind (including a kind whose samples are
all retired, which reads no longer list); otherwise it creates one. `replaces` names an active sample of the
same kind, retired as `replaced`. `retire_samples` lists active sample IDs, retired as
`removed`. After an insert the oldest beyond two per kind is retired as `evicted`.
A `sample` whose text is byte-identical to an active sample of the same kind inserts
nothing and evicts nothing (a `replaces` naming another sample still retires it); a
save that then changes nothing returns `unchanged` and charges nothing.
Sample errors fail with `sample_conflict`. A `saved` result carries
`samples_retired: [{id, reason}]` whenever a sample was retired, and replay returns
it unchanged. Report reads list each active sample as `{id, kind_id, kind, context,
date}`, newest first; kind labels never appear in report text.

The assistant offers first setup once when empty, uses available explicit
instructions or asks questions, and shows the full draft for approval before
saving. Milton cannot inspect other assistants' memories. It stores instructions,
not factual/project memory. The assistant applies the rules and samples to its drafts itself.

Two offers follow from drafting. When the person approves a draft to send, post,
or say, the assistant offers once to save it as a sample under the report that
applies, quoted exactly with one line of context; a no is final for that draft and
nothing is saved silently. When the person makes the same correction twice, the
assistant proposes one short rule and files it only on approval; a single
correction is a one-off. Both run through `create_memo` with ordinary approval.

Usage guidance travels in three places: server `instructions` during MCP
initialization, descriptions in `tools/list`, and descriptions on the save input
fields. Connection instructions explain the shared read/setup/save workflow;
tool metadata explains when to use each tool, and field descriptions explain the
opaque version and same-request retry rules. Server instructions stay at or under
4,096 characters, because Claude Code truncates longer ones; a test enforces this.
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

Access tokens require a valid signature, exact issuer/resource audience and expiry.
Only the verified account supplies tenant identity. MCP calls do not admit users.
Browser viewing requires a live session; sign-in/consent/logout retain their CSRF
protections. Signing out of the browser does not disconnect assistants, and an
already-issued access token can remain valid until expiry. Disconnecting an
assistant on `/assistants` records its (identity, client) in
`assistant_disconnects`; the MCP server then refuses that client's tokens,
unexpired ones included, with 401 `invalid_token` until the person approves it
again on the consent page. Neon's own refresh tokens are not revoked.
`/account/delete` (typed confirmation) records a disconnect for every live
consent and a one-way `sha256("provider:subject")` in `deleted_identities`
(no second trial on re-signup), then deletes the `users` row in the same
transaction; every tenant table cascades. Global spend counters and the
opaque-id gardening/derivation counters are kept. It then removes the Neon
consents and signs out, best effort; the Neon Auth user record is not deleted.

## Local development and checks

Use a development Neon branch. Put the runtime environment variables in ignored `server/.env.local`, and configure the app and MCP URLs for your chosen loopback origin and port. Enable loopback access in that branch's Neon Auth settings and set its login, consent, and trusted-origin settings consistently. Apply migrations and configure admission for that database too.

The local server uses port 3001 unless you override it with `PORT`. Check that the port is unused before starting. From the repository root:

```sh
bun run --cwd server dev
```

In another terminal, run the interactive OAuth check:

```sh
bun run --cwd server test:local
```

The check uses the default local origin. If you changed the port or origin, supply `--origin` with the origin hosting `/mcp`, without the `/mcp` path. Open the loopback page address it prints and complete sign-in manually. It checks OAuth discovery, DCR, PKCE, callback state, connection instructions, exactly four tools, and a current cover sheet read. It does not save instructions, open a browser automatically, or print tokens.

Run automated checks from the repository root:

```sh
bun run check-types
bun test
bun run --cwd server test:client
```

The tests use fresh PGlite databases and stubbed Auth responses. `test:client` uses an in-memory SDK connection to an empty stub store. These checks need no live Neon credentials. The interactive `test:local` check does contact your configured Neon Auth service. Embedded tests do not prove contention between independent Neon connections.

## Store, history, and limits

`src/store/compiled.ts` snapshots all instruction-card heads under the account lock and
claims the request in a short transaction, then resolves the save against that
snapshot and publishes in a second transaction. Exact edits and moves name existing
cards only through unique anchors; `rules` entries become new cards with
server-assigned IDs. Omitted cards keep their exact bodies, descriptions and versions.
The cover sheet and reports are assembled from the final stored active bodies and
samples (see 0017 below). Bodies are not trimmed, rewritten or truncated, apart from
one stored leading `- ` that the printed bullet replaces;
descriptions are metadata, not an additional instruction source. Publication rechecks
the account, request deadline, source fingerprint and report version; card versions,
the current snapshot, receipt and any memo-update charge commit together. Stale or conflicting
saves cannot partially publish.

Internal `instruction_card_versions` are append-only; legacy `memo_versions` are retained. `tps_reports` holds one replaceable
snapshot per account, with a monotonic revision and source fingerprint. There is
no report content history. Receipts keep input hashes and bounded outcomes, not raw
submitted text or copies of reports. Their maximum 2-KiB result space plus metadata is
reserved against retained-history capacity when claimed, so terminal failures fit.
Completed receipts are immutable. A crashed request can expire; the same ID never
applies again.

Saves anchor only in current active cards, never archived versions or a prior snapshot.
Existing content under the former `vibes` core key is ordinary source. Invalid Unicode
in submitted text is rejected before a driver can replace it. The database validates
identity, complete publication and size limits. If a report or the full text exceeds
its bound, the whole publication rolls back with `tps_body_limit`; the failed
request receipt remains, but no source change or memo-update charge commits. No read or
save invokes a model.

| Limit                                       | Default                                                           |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Internal memos, including archived          | 100 (historical `vibes` row retains its existing guard exemption) |
| Rule (card) body                            | 32 KiB UTF-8                                                      |
| Cover sheet or report body                  | 256 KiB UTF-8 each (`report_body_bytes`)                          |
| Description/reason                          | 500 UTF-8 bytes each                                              |
| Retained memo versions and bounded receipts | 64 MiB per account                                                |
| Attempted MCP calls                         | 1,000 per account per UTC day                                     |
| Launch memo updates (0014, default off)     | 100 successful user-directed batches per account per UTC day      |
| Request body                                | 64 KiB before parsing (`MAX_REQUEST_BYTES` in `src/http.ts`)      |

The memo-update allowance is the only daily save cap: each successful
`create_memo` that changes rules or samples charges one update, regardless of how
many internal memos it touches (0014). No-op, conflict, failed saves and receipt
replays charge nothing. While the allowance is off (the 0014 default), the
attempted-call limit is the only daily bound on saves. The former 200-a-day
technical write quota is retired; its
`daily_writes` key and `usage_daily.writes` column stay unread until a migration
drops them. Every attempted MCP call still counts, including retries. There are no
public archive/restore exemptions or history controls.

The website shows the current cover sheet and reports, escapes their text and serves no browser JavaScript.
It displays one bullet per complete active instruction card, preserving internal
line breaks and conditions and dropping one stored leading `- ` as assembly does,
only when a browser-only tenant-locked lookup returns the same version as the
canonical report; it does not compare the text.
Unavailable or mismatched layout data keeps the original plain-text view. Report
pages preload the shared Geist and JetBrains Mono fonts; the theme uses
`font-display: optional` to avoid a late font swap.
`/download` returns the unchanged exact report text as `TPS.md`. Old memo/history/recovery
routes return 404.

## Reports, samples and the cover sheet (0017)

A report is the unit of the assembled output. 0017 gave each instruction card a
`report`: one of `email`, `chat`, `post`, `document` or `speech`, or NULL
for a rule that applies to all writing (0020 moves it onto card versions; see below).
The migration backfilled it from the group
title a card was filed under (a title naming a report becomes that report; every
other card, including archived working-style rules, belongs to the cover sheet) and
deletes groups that never held a card or a legacy version. Group tables remain as
history only; assembly no longer reads them.

Approved samples live in `samples`: report, a free-form `kind` label, one `context`
line, the `body` exactly as submitted, the filing client, and `retired_at`. A guard
makes the table append-only: the only update sets `retired_at` once, and rows leave
only with their account. Filing a sample through `create_memo` with the `sample` field
makes no model call and reserves no budget. The newest sample per kind wins; at most
two per kind stay active, and retirement is the only automatic change.

Assembly is deterministic and runs on read. Every rule prints as one bullet: `- `
followed by its stored body, with one stored leading `- ` (as the retired compiler
filed rules) dropped first, so rules from either era read alike. Known limitation: a
rule whose own text starts with `- ` (stored as sent) prints as a plain bullet, so a
reader cannot tell that dash is content. Stored cards are not
edited. The cover sheet is the cover-sheet rules joined by blank lines; the fixed
report index (one "when" line per report) travels beside it as data. Each report
prints `# Title`, its when line, its active samples newest first (a context line with
the date, then the body quoted with `>`), then its rules. `tps_reports` keeps the
version fence and the full text (cover sheet plus every non-empty report) as last
published; reads, the web page and TPS.md serve a fresh assembly at that version. The fence is the card
fingerprint when no samples exist, so pre-0017 snapshots stay valid; with samples it also covers the active sample IDs. A read whose stored fence
lags its sources rebuilds and publishes under the account lock instead of failing, so
there is no refresh step and no `tps_report_unavailable` error. An empty account
without a snapshot stays unwritten.

Each body has its own cap (`report_body_bytes`, 256 KB by default); the full text is
bounded at six bodies. Caps measure the printed text, bullets included. A save that
would exceed a cap is refused with `tps_body_limit` and nothing is truncated or
published. Reads are not rechecked, including a read that rebuilds a lagging snapshot:
it publishes what is on file even above a cap lowered since, and only the next save is
refused. A snapshot last published before rules printed as bullets can read up to two
bytes per bare rule over the cap until its next save. Card text still cannot contain a Markdown
heading line (`card_heading`). Each `rules` entry names its card's report; since 0020
a card moves only through an explicit `moves` list.

`drizzle/rollback/0017_reports.sql` works only while no sample exists and no full
text exceeds the old 32 KB bound. It does not restore deleted empty groups, which the
previous runtime never read.

## Filing moves and sample kinds (0020)

A card's report lives on each version (`instruction_card_versions.report`, NOT NULL,
one of the five reports or `cover`); `instruction_cards.report` is dropped. NULL never
means the cover sheet. A move appends a version with the same description and body
(`details.kind` `move`); an edited and moved card gets one version carrying both.
The card fingerprint is unchanged in shape, so a move changes the fence. A moved card
keeps its position. Legacy memo writes append versions in the card's current report.

`sample_kinds` holds immutable kinds: `(user_id, id, report, label)`, labels unique
per report by `lower(label)`, rows removable only with their account. `samples`
references its kind through `(user_id, kind_id, report)`, so a sample's report is its
kind's report by construction, and `replaces_id` through `(user_id, replaces_id,
kind_id)`, so a replacement is always the same kind. Retirement sets `retired_at`,
`retire_reason` (`replaced`, `removed`, `evicted`) and the retiring `request_id`
once, together; nothing else changes. The migration files every existing version in
its card's report (NULL becomes `cover`), creates one kind per report and case-folded
label (spelled as its earliest sample), and marks already retired samples `evicted`
with no request ID.

The previous runtime evicted by exact `kind`, so "Follow-up" and "follow-up" could
each hold two active samples. 0020 merges them into one kind that can briefly hold up
to four. They stay listed until the next sample of that kind, whose save evicts the
oldest beyond two, which may be samples the person did not touch, and reports them in
`samples_retired`.

`drizzle/rollback/0020_filing_kinds.sql` is lossy: each card returns to its latest
version's report, and retirement reasons, retiring request IDs and replacement
lineage are dropped. Case variants of one label return as that kind's label.

### Trial transition groundwork (0012, inactive)

Trial transition groundwork is **off by default** (`store_config.trials_enabled=false`).
The selected launch price is **USD $5.01/month**, one plan, no per-assistant fees.
Future Stripe price configuration must use 501 USD cents, replacing the earlier
$5 proposal. Current early access remains free; no payment price exists in this slice.
Billing is not launched. Do not enable it until authenticated `/billing` checkout,
verified provider entitlement synchronization and the remaining launch policies are
implemented and tested. This slice contains no Stripe API/webhook, checkout page,
credentials or live subscription actions. Until `/billing` exists, the trial notice,
the page banner and the `subscription_required` refusal carry no subscription link;
the banner names the price as plain text. Existing early access must not acquire a payment gate implicitly.

When explicitly enabled, only newly admitted accounts get a `trial_accounts` row.
Existing accounts without a row remain early access, including on later sign-ins.
The account-creation transaction starts a 720-hour trial using the new Milton
account's `created_at` timestamp. The start is required for every enrolled account;
reads, first/later saves, failures, replay and later sign-ins never reset it.
An enrolled account can expire without ever saving preferences. No start-trigger
explanation is shown in the product. Store
only the start, a trusted paid-through projection and a reminder milestone; no
preference bodies or payment details enter these records. Account deletion cascades.

Every MCP tool may attach a separate `notice` object to a successful result in the
last seven days and last day. Atomic account-wide claims offer each milestone at
most once across assistants and tools; returning during the last day skips
the earlier reminder. A lost response or timed-out notice lookup can lose that
reminder. Delivery does not establish display or acknowledgment. Lookup is bounded
to one second, with short database lock/statement limits, and never turns a
confirmed save into failure. The website banner does not consume MCP reminders. Background lifecycle hook
reads return instruction context only and do not consume billing notices.
Report text, version, downloads and saved receipts contain no billing notices.

Expired unsubscribed accounts receive a tool error `subscription_required` with
`retryable:false` and no link, as the instructions say. This is not an
authentication failure or an empty successful report. New saves are checked when
claimed and again under the publication lock; a save that crosses expiry fails
without publishing. Exact replay still
recovers an already accepted receipt. Web view/download remains available.

A trusted future subscription integration sets `paid_through`; the next request
rechecks access, so reconnecting an assistant is unnecessary. This field is not
writable through any MCP/browser input in this slice. Preserve `started_at` and
its original trial end when subscribing early; the future checkout must delay the
first charge until that end. No checkout or billing-date behavior is claimed tested
by the local paid-through fixture. Cancellation, failed-payment grace, existing-user
transition, retention duration and paid allowances still require selected policies.

Migration 0012 is additive and performs no enrollment/backfill. Rehearse on disposable
PostgreSQL before any rollout. The rollback parks `trial_accounts` intact and disables
enforcement; its `_reforward.sql` restores the same rows with enforcement still off.
Stop trial-aware runtimes before this inverse. Old runtimes do not enforce access
and are not paid-service rollback candidates; recover forward with compatible code.
Do not reset clocks, erase notices or infer subscription state during recovery.

### Durable accepted changes (0010)

Every successful `create_memo` change writes immutable internal provenance in the same
transaction as card history and the report snapshot. (Records from the removed refinement Apply keep
their `refinement_apply` operation.) It preserves the exact submitted instruction or
exact edits, `rules` and stated purpose, actor, request ID, affected before/after card-version references, source/report revision
hashes and transformation identity. It records only what Milton received, not a conversation
or proof of the human's full intent. Legacy missing request evidence is not reconstructed.
No-op and failed saves add no accepted-change record.
Replay adds no duplicate. New saves record transformation pipeline `exact:v1`.

Records live as long as internal history and are removed with account deletion. Their
serialized payload bytes count against the existing retained-history quota; an over-quota
save fails atomically instead of dropping evidence.
Migration 0010 is additive and copies no legacy request text. Its inverse parks evidence,
foreign keys, immutability guards and byte charges in `milton_rollback`; forward migration
restores them exactly. Stop writers during schema rollback and keep them stopped until
forward recovery: an older runtime cannot guarantee provenance for new saves.

### Spend-alert worker

The private worker publishes spend alerts (0014) and delivers their email (0015); it
calls no model. Cloud Scheduler job `milton-gardening` invokes GET `/api/garden`
every minute with an OIDC token from the dedicated scheduler service account; the
job and route keep their historical names. Cloud Run verifies that token and the
service-level `roles/run.invoker` grant before the request reaches Milton, and
internal ingress refuses public requests. Request bodies, query parameters and
account identifiers cannot steer it. Pin the worker image and both secret versions,
and pause the old scheduler for 180 seconds before enabling a replacement.
See [deployment and rollback](deploy/README.md).

### Memo-update allowance and reservation alerts (0014)

Migration 0014 is additive and defaults off. It preserves existing receipt JSON,
source/history, the report snapshot and trials. After every writer and worker
runs compatible code, the operator can select explicit SQL alerts-only policy and
mark that boundary ready. From `server/`, with the protected database/dotenvx setup:

```sh
bun --no-env-file scripts/memo-updates.ts policy --compatible-writers
bun --no-env-file scripts/memo-updates.ts enable
```

`policy` does not enable updates; `--daily-limit` makes a deliberate override.
Configure every runtime for the selected SQL policy before enabling. No command activates trials, billing or model
work. `disable` stops allowance enforcement without erasing holds
or charges; drain mutating traffic/holds before a compatible rollback.

The launch allowance is **100 memo updates per account per UTC day**, shared across
assistants, with no rollover. One committed save that changes rules or samples
consumes one. Unchanged saves, failed or rolled-back publication, snapshot
rebuilds on read, reads/downloads and completed-request replay consume zero.
Historical/pre-activation claims stay uncharged. Saves keep their
post-lock claim day across midnight. The captured claim timestamp plus 40 seconds
remains the publication deadline. An expired hold no longer occupies capacity and
cannot publish late.

A new potentially mutating request at zero available updates is refused before it
claims. `memo_updates_exhausted` differs from `memo_updates_pending`; the retired
`model_budget_reached` appears only in older receipts. Reads retain existing
access/trial policy. Concurrent claims serialize before dispatch. Same-ID recovery
wins over a new quota check; an uncertain claim is not redispatched or refunded,
and an uncertain publication recovers the original receipt.

MCP `memo_updates` metadata contains `limit`, `used`, `pending`, `available`,
`resets_at` and `as_of`. Save `memo_update` separately describes the original
request's charge/state/day/replay. Both are outside report text and immutable receipt JSON.
The advisory balance lookup is bounded and omitted on failure; it cannot reverse a
confirmed save. Core quota checks fail closed. Final MCP events contain only known
tool/outcome/error values, elapsed time and charge/replay/release state, without
client/account identity, instruction text or result bodies.

`foreground_usage` is seeded under a receipt write fence and maintained atomically
by insert triggers, including compatible legacy inserts. Its bigint totals have no
account foreign key; deletion/replay/completion never refund provider reservations.
Historical receipts deleted or misdated before migration cannot be reconstructed.
The frozen review/derived ledgers keep their deletion-safe totals (0018). These
conservative reservations are observations, not invoices or user updates.

The scheduled spend-alert worker observes current and retained prior UTC days.
Default combined reservation
thresholds are **$100/$250/$500/$1,000**. Optional
`MILTON_SPEND_ALERT_THRESHOLDS_USD` is an increasing comma-separated ladder of at
most 16 levels. At each observation, only the highest newly crossed level publishes;
unpublished lower levels are covered and previously published snapshots stay stable.
A pre-midnight crossing is caught after midnight. Publication rollback/unknown-ack
replay is idempotent. Observer failure never stops customer/model work. The one-cycle
`memo-updates.ts observe` command is diagnostic; it is not the scheduler.

### Spend-alert email (optional)

The private scheduled worker can deliver the same published aggregate alerts as
plain-text email through [Resend](https://resend.com/docs/api-reference/emails/send-email).
Configure its protected environment (dotenvx/Secret Manager), never the repository:

| Variable                        | Value                                              |
| ------------------------------- | -------------------------------------------------- |
| `RESEND_API_KEY`                | Resend sending key for one stable provider account |
| `MILTON_SPEND_ALERT_EMAIL_FROM` | Bare sender address on a Resend-verified domain    |
| `MILTON_SPEND_ALERT_EMAIL_TO`   | Bare operator recipient address                    |

With all three absent delivery is disabled; partial/invalid configuration logs a
sanitized failure without blocking publication. No new dependency or public route
is required. The subject always starts with **`[Milton spend alert]`**. The body
contains type, warning severity, reserved amount and threshold, “Milton — all
accounts,” UTC timestamp, opaque alert ID and the token-free Google Cloud project
console link. These global alerts cannot identify an individual customer. No
capability-feed URL, credentials, source instructions or customer PII enters email.

Each scheduled cycle reconciles published alerts from the retained 31 UTC days
and sends at most one pending email, so first activation also catches up existing
published events. Covered lower thresholds are not emailed. Publication commits
before delivery; a delivery/configuration/provider failure never rolls it back or
changes customer/model-work status. The separate durable ledger freezes the
sender, recipient, subject and body and uses the alert ID as Resend's idempotency
key. Changing sender/recipient configuration affects only newly queued alerts.

[Resend keeps idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys).
Requests use a 5-second timeout, 60-second claim lease and five-minute retry delay.
Transport/5xx/429/concurrent-request failures retry the same request only within
23 hours of the durable first attempt. An expired ambiguous attempt becomes
`unknown` and is logged for manual provider reconciliation; it is never resent
with a new key. Permanent HTTP refusals become `failed`. `sent` means provider
acceptance, not inbox delivery. Keep the same Resend account across key rotation;
moving to a different provider account requires reconciling pending deliveries.
Logs include only the opaque alert ID and a bounded error category/status code.

Apply additive migration `0015_spend_alert_email` before enabling email. Its
rollback script permits removing the empty table only before any delivery record
exists. After activation, disable delivery by removing all three variables and
roll back the runtime while retaining the table, immutable envelopes, provider
IDs and deduplication epochs. Never delete/reset delivery records to retry or
restore an earlier database snapshot: that can send duplicates after Resend's
idempotency window. No live provider delivery is implied by local fake-provider
checks; verify the configured sender and a controlled delivery during activation.

The optional feed uses one direct **GET/HEAD JSON capability URL** under the stable
nonsensitive `/operator/spend-alerts/` prefix on the app host. It has no browser code,
cookie login, HTML viewer, new MCP tool or public write endpoint. It exposes only
up to 100 recent published aggregate snapshots with opaque IDs, UTC timestamps,
thresholds and exact decimal reservation totals. Publication does not mean a client
read or notification. Missing/invalid/revoked keys refuse without data or redirects,
including on the MCP host. Responses are JSON, no-store, noindex and no-referrer.
Only the current SHA-256 hash is stored; every read checks revocation afresh.

**Before provisioning or using any real capability**, the release owner must prove
that all applicable platform, ingress/proxy and inherited request-log routes cannot
persist the credential URL, then verify with nonsecret canaries and a positive
logging control. Application redaction or project-only exclusions cannot establish
that an unverified inherited destination is safe. Keep the hash NULL and the feed
unprovisioned until this gate is resolved. This gate does not block the local build
or the separately authorized allowance rollout.

After that proof, the operator CLI requires a protected owner connection and an
owned private output directory. It never accepts a key argument or prints a key:

```sh
bun --no-env-file scripts/spend-feed.ts rotate --logging-verified --output /absolute/private-directory/feed.url
bun --no-env-file scripts/spend-feed.ts revoke
```

The attestation flag is not automated logging proof. Rotation creates a new 0600
file exclusively, writes/fsyncs it before activating its hash, and preserves the
file on an ambiguous commit. It never overwrites files or follows output symlinks.
Use the protected file for authorized HTTPS curl/client polling without copying the
URL into shared terminals/logs. Rotation replaces the hash; revoke clears it.
Already admitted in-flight responses cannot be recalled. Client polling and actual
notification need separate verification; the API does not record read receipts.

The preserving `rollback/0014_memo_updates.sql` requires disabled enforcement and
drained holds and retains receipt/charge history, counters, events, triggers and
current key/revocation state. Reforward restores readiness but never enables the
allowance or restores an older key. After activation use only a runtime compatible
with accounting, alerts-only policy and capability prefix/hash checks; keeping the
schema does not make an older runtime compatible.

### Derived-systems removal (0018)

Embeddings, advisory graphs, task-aware retrieval and observation-only gardening are
removed from the code. Migration 0018 refuses an unexpired gardening lease, deletes
remaining jobs so `users.retained_bytes` stays reconciled, and drops `gardening_jobs`,
`card_embeddings`, `card_retrieval_embeddings`, `card_graphs`, `card_links`,
`retrieval_enrollments`, their two trigger functions, the four `store_config`
derivation columns with their checks, and the `vector` extension. `gardening_usage`
and `derivation_usage` stay as frozen ledgers because spend totals read them; a later
migration drops them no earlier than 31 days after their newest row. The 0018 rollback
script recreates the dropped objects empty; their data is recoverable only from the
pre-migration snapshot. Release the code before applying 0018; see
[the hosting runbook](deploy/README.md#derived-systems-removal-0018). The
[research note](../docs/research/derived-systems-2026.md) records what was measured and
what would justify rebuilding any of it.

### No count limit (0021)

Migration 0021 replaces `milton_card_guard` and `milton_memo_guard` without their count
checks; card identity stays immutable, writes still need an active account and memo
names keep their byte cap. `limits_json.memos` stays in the row, unread. Saves stay
bounded by the daily memo-update cap (hosted), the tool-call rate limit and the byte
caps. Apply 0021 before releasing the code: the previous runtime runs on either guard,
while the current one without 0021 would hit the old lifetime count as
`store_unavailable`. `drizzle/rollback/0021_no_card_count.sql` restores both previous
functions and changes no rows; an account already past the old limit keeps its cards
and cannot add more until it is back under it.
