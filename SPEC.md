# Milton: spec

## Current build: Instruction cards, reports, samples and the cover sheet

Product direction comes from Peter's product note of 2026-11-02 (kept with the
agents' working notes, not in this repository); where this section and the note
differ, the note wins. Its vocabulary applies here: a memo is anything sent to Milton
(a rule, a correction or an approved sample), a report is one assembled document per
writing situation, and the cover sheet carries the rules true of all writing plus the
report index. "TPS Report" and "group" are retired words; they survive only as code
identifiers such as `tps_reports`, `TPS.md` and `tps_body_limit`. This section records
the contracts as built and supersedes older tool, history-screen, authored-TPS and
recovery choices below. Agents use only `get_cover_sheet`, `get_report`, `list_reports` and
`create_memo`. Saves are model-free: the assistant names each rule's
report and sends its exact approved wording, and Milton stores those bytes. Complete
instructions, including conditions and exceptions, are independently versioned cards. Each card belongs to one of five fixed
reports (`email`, `chat`, `post`, `document`, `speech`) or to the cover sheet, the
rules true of all writing. Approved samples are stored exactly as sent in their own
append-only table, newest per kind winning and at most two per kind staying active.
Assembly is deterministic and runs on read: the cover sheet is its rules in
write-once insertion order, after one fixed note on the `Baseline: ` prefix while any
active rule carries it; each report prints its heading, its when line, its
samples newest first, then its rules (0017). Every rule prints as one bullet, with
one stored leading `- ` dropped first so rules filed by the retired compiler and rules
stored as sent read alike. Card text cannot contain Markdown
headings. The card fingerprint, extended by active sample IDs, fences every
published version. The memo group tables (0016) remain as history only.

Filing is correctable (0020): a card's report (or `cover`) lives on each version, so
an explicit `moves` entry appends a version that keeps the card's identity, text and
history; no card moves to tidy up. Samples belong to stable, immutable
kinds named once per report; assistants reuse a `kind_id` from `get_report` and use
`new_kind` only when none fits. `replaces` and `retire_samples` retire samples on
request; every retirement, including the automatic newest-two-per-kind eviction, is
reported in `samples_retired` and recorded with its reason and request. Kind labels
stay out of report text.

Embeddings, advisory card graphs, task-aware retrieval and observation-only gardening
were built, measured and removed; migration 0018 drops their schema. What they showed
and what would justify rebuilding any of them is in
[the research note](docs/research/derived-systems-2026.md).

Assistants offer to save a sample on approval and a rule on repeated correction, each
only with the person's yes; no automatic capture. Closed-client execution and actual
instruction adherence remain outside the server's guarantee.

Every save is exact. `create_memo` needs at least one structured field: `rules`
(1 to 25 entries of `{ report, text }`, `report` one of the five or `cover`),
`exact_edits`, `moves`, `sample` or `retire_samples`. A save with none is refused
with `invalid_input` ("Name the report and send the rule's text in rules."). Each
`rules` entry becomes one new card stored byte for byte; its description is its first
non-blank line, trimmed and cut to the description cap, with no model. An entry whose
text prints like an active card in the same report, or an earlier entry in the same
request, is skipped; a save that then changes nothing returns `unchanged` and charges
nothing. `text` is the stated purpose: recorded with the accepted change, never stored
as a rule. A rule stored starting with `Baseline: ` must match the first-setup
catalog byte for byte, in the report it is served for (`baseline_unknown` otherwise); the setup script served on the
cover sheet and on each report without rules is rendered from the same data. Corrections go through `exact_edits`; an edit whose `before` is a whole rule
and whose `after` is empty retires it. All fields resolve against one claimed snapshot
and apply atomically. Anchors resolve uniquely within active card bodies, never
against generated text; overlapping edits fail. The source/report fences, receipt and
replay, history, size and heading limits and the single memo-update
charge still apply; reservation is always zero. A report exceeding its bound refuses the
entire save; source instructions are never truncated. Count one successful logical
save against the 100/day memo-update cap; no-ops, failures and replays charge
nothing. A save's claim takes only the account lock and reads the cap without locking
`store_config`. Keep the separate 1,000 attempted-call and retained-history limits.

Removing the model removes paraphrase drift, not interpretation risk: the assistant
picks the report and wording, and a free-text correction sent as a new rule leaves
two rules that disagree. Nothing detects that; the instructions require exact_edits
for every correction. Stored receipts from the retired model path (for example
`needs_clarification`) still replay.

History belongs to internal instruction cards; legacy memo history is retained. The
cover sheet and reports keep only a current snapshot and a version. The website shows
them and downloads TPS.md; it exposes no memo-management or history/recovery UI. There are no legacy tool aliases or
compatibility rollout paths. See server/README.md for the current contracts,
configuration, migration and local verification instructions.

The web report offers viewing and TPS.md download only. Report refinement (preview,
Apply and Discard) has been removed; its routes return 404. Wording changes go through
`create_memo`, including `exact_edits`. Historical refinement receipts and accepted-change
records stay in the database unchanged.

A read whose stored snapshot lags its sources rebuilds and publishes it under the
account lock (0017), without changing card history, invoking a model or fabricating a
save; there is no separate refresh step.

Migration 0008 conservatively carries each complete legacy memo into one card,
keeping IDs, versions, source order, exact text and all old history. No model splits
existing instructions. Cards organize and narrow edits; they do not establish semantic correctness.

Accepted changes now retain the exact submitted purpose, rules and edits, actor, affected card
versions and transformation identity atomically with source, history and the report snapshot. These internal
records use the existing history quota and account-deletion policy. Missing legacy
request evidence remains unavailable.

The rest of this document preserves earlier design history; it does not authorize
production actions or override the current contract above.

### Session capture: MCP-only first

Optional capture uses existing `get_cover_sheet`, `get_report` and `create_memo`, with explicit opt-in
for the current conversation and an immediate stop instruction. Connection consent
and first-draft approval do not enable capture; opt-in never replaces approval of
the complete first draft for an empty account. Capture controls stay in the conversation,
not in the shared reports. At task completion, the assistant compares explicit reusable
standing rules against the current cover sheet and reports and saves only genuine changes with
their original scope and conditions. Exclude one-off requests, project facts,
unconfirmed inferences, transcripts, secrets and other people's private details.
Stopping capture preserves existing instructions and cannot undo submitted saves.

Separately from capture, two offers need no opt-in because each save still waits
for a yes: on approval of a draft, the assistant offers once to save it as a sample
under the applicable report; on the same correction twice, it proposes one rule.
A no is final for that draft, and a single correction stays a one-off.

This is assistant guidance, not a server-enforced consent setting or a background
service. No hook or plugin is required. The assistant must call the tools, respect
client approvals and use existing save recovery rules. Session-end capture and
silent/nonblocking behavior are not guaranteed. Evaluate missed instructions and
incorrect saves across clients before claiming reliability; consider hooks only
if evidence justifies their installation burden.

_Design notes, kept in the order decisions were made. The sections up to "Version 2: Milton for anyone" describe the first, read-only plan and are history; what runs today is version 2 (README.md says what is built). Explanatory terminology uses the current name, memos; literal old tool and path names in historical sections are retained._

## What it is

Milton is one private server that every AI assistant Peter uses can connect to, so they all write and work the
way he wants: his email voice, his working style and, later, other memos. It is an MCP server (the
standard plug-in format that Claude, ChatGPT, Muse and Grok all accept as a "custom connector").
Agents can read memos and, with permission, suggest changes or save notes.

Milton takes over the shelved Milton project: its repository `ptshih/milton`, the domain `meetmilton.com`, the Cloudflare account that holds its DNS, and the GitHub App `milton-assistant`. The original plan kept memos in that repository. Version 2 below supersedes this storage model.
That repository is the source: Peter edits it, the server serves it, and agents propose changes to
it. Nothing private ever goes in it, so nothing private can leak through the server.

## Who connects

| Client                                | How it connects                                                                                                                  | Confidence                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| claude.ai (web, Desktop chat, iPhone) | Custom connector, sign-in with OAuth; added on the web, then available on Desktop and iPhone. Pro plan or above                  | Confirmed (Anthropic support article) |
| ChatGPT                               | Developer mode → custom connector, OAuth. Which plans allow it, and whether personal plans can write, is unclear                 | Likely; test on Peter's plan          |
| Meta Muse                             | Settings → Connectors → custom connector by URL. Sources disagree on OAuth versus a key in a header, so the server supports both | Likely; test                          |
| Grok Bot                              | Settings → Plugins, remote connectors on a paid plan                                                                             | From forum posts only; test           |
| Claude Duet                           | Unknown: Peter to say what it is                                                                                                 | Open                                  |
| Claude Code, Codex, Pi                | Read the repository's clone on the Mac directly (below); can also use the server                                                 | Confirmed                             |

## What it serves (version 1)

- **email-voice**: moved from `~/.agents/skills/email-voice` into `recipes/email-voice/`.
- **working-style**: a new short memo for working with Peter outside code (answer first, plain
  English, render options before applying, a terse word authorizes one step, "what do you think"
  asks for candor). Peter approved its text on 2026-10-29.

The repository holds only memos meant for every assistant. Employers, investors, customers, project
rules, tools and memory stay in `~/.agents` and the project repositories, which the server never
reads.

## What agents can do

Every tool call is logged with the client's name.

| Tool                                       | What it does                                                                              | Needs |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ----- |
| `list_recipes`                             | Names and one-line descriptions of every memo                                             | read  |
| `get_recipe(name)`                         | One memo in full                                                                          | read  |
| `get_vibes`                                | The vibes memo                                                                            | read  |
| `search(words)`                            | Plain text search across memos                                                            | read  |
| `remember(note, topic)`                    | Adds a note to an inbox for Peter to review, such as "Peter prefers 'Best,' to 'Thanks,'" | write |
| `propose_change(recipe, new_text, reason)` | Opens a pull request with the edited memo; nothing changes until Peter merges it          | write |

The server also sends one standing instruction when a client connects: "Before writing anything for
or as Peter, call `get_vibes` and the memo that fits the task." Clients that ignore it get the
same line in their own custom-instruction setting.

## How writing works

Agents never change a memo directly. A `remember` note is committed to `inbox.md`; a
`propose_change` opens a pull request. Peter reviews on GitHub, from the phone if he likes, and
merges or closes. The server serves the merged memo within minutes. A client gets write access only
if Peter granted it when connecting, so Muse can be read-only while claude.ai can propose.

**Alternative, if review proves too slow:** direct commits, each one revertible. Not recommended for
version 1: one bad write would change every assistant at once.

## Local agents

The repository is cloned at `~/code/milton`. Each memo that is also a skill is linked into
`~/.agents/skills` (and from there into Claude Code, Codex and Pi, as skills are today), so local
agents read the same files the server serves. A `git pull` brings merged changes down; there is no
sync script and no second copy.

`~/.agents` keeps what only coding agents need: project rules, tools, memory. The memory brief's
`USER.md` rules stay there for coding sessions; where a rule also belongs in working-style, the memo
holds the full version and `USER.md` keeps a one-line pointer, so the two don't drift.

## How it is built

- **Repository** `ptshih/milton` (Peter's personal account): `recipes/<name>/SKILL.md`, `inbox.md`,
  the Worker's code in `server/`, and pull requests for proposed changes.
- **Cloudflare Worker** with the Cloudflare Agents MCP handler (`createMcpHandler` on MCP SDK v2, no
  Durable Object) and the Workers OAuth Provider library. Version 1 bundles the memos into the Worker
  at deploy time from `recipes/`, so a merged change ships with the next deploy. Reading and writing the
  repository as the GitHub App `milton-assistant`, narrowed to that one repository (contents and pull
  requests) with a short cache, comes with the write tools, which need the App anyway.
- **Sign-in:** OAuth with GitHub as the login, allowed for Peter's GitHub account only (login and
  numeric id), with dynamic client registration for claude.ai. The login goes through one GitHub
  App, `Milton (local)`, registered only to say who is signing in, with no repository permissions.
  A GitHub App takes several callback URLs, so the same app serves `http://localhost:8787/callback`
  and `https://mcp.meetmilton.com/callback`. Its id and secret live in the Worker's secrets, locally
  in the ignored `server/.dev.vars`. For clients that only take a key (possibly Muse), one revocable
  token per client, checked by the same server. Scopes `read` and `write` per client.
- **Address:** `mcp.meetmilton.com`, on the Cloudflare DNS that already serves `meetmilton.com`.
- **Reused later, not in version 1:** the Google Cloud key for Gemini (for features such as
  summarizing the inbox); the Vercel projects behind `meetmilton.com` and `app.meetmilton.com`. The
  Neon database is exported, then retired.

## Cost

Cloudflare's free tier (100,000 requests a day, plus the key-value store the sign-in needs) and a
free private GitHub repository: likely $0 a month at this volume.

## Build order

1. Archive the old Milton (tag, branches, uncommitted work as patches), clear `main`, then add the
   memos: email-voice moved in and linked back into `~/.agents/skills`, and working-style drafted
   for approval.
2. The read-only server: built, reviewed, signed into locally with Claude Code as the client and
   deployed at `mcp.meetmilton.com` (2026-10-29); connect claude.ai and test on web and iPhone.
3. Connect Muse, ChatGPT and Grok; add the per-client token if any of them needs it.
4. The write tools: inbox notes and pull requests.
5. A standing instruction in each app where the server's own instruction isn't enough.

Each step ends with a check: the client drafts an email with the memo and the result follows it
(read); a proposed change opens a pull request and, once merged, is served and appears locally after
a pull (write).

## Decisions for Peter

1. **Writing:** review queue as above (recommended), or direct commits.
2. **The working-style memo:** approve its text before it is published.
3. **Claude Duet:** what it is and how it connects.

## Not in version 1

Anything about employers; memory facts; letting agents delete memos; a web page for browsing memos
(GitHub already shows them); Obsidian (it can open the `recipes` folder as a vault later).

## Version 2: Milton for anyone

_Decided with Peter on 2026-10-29, after version 1 went live, with two skeptic reads; he chose
direct writes and one shared database the same day. Nothing of this is built._

### Decisions taken

- **Anyone can use Milton.** Sign-in with GitHub now, Google next; any account, not only Peter's.
- **Memos live in Milton's own store**, not in each user's repository. A download of the memos
  as Markdown is a feature, not the source.
- **Agents author content; people recover it.** The web page displays memos and restores stored versions. An assistant uses
  tools: it may create and update a memo, and archive one, never delete. Every write records which
  client made it.
- **Every version is kept**, and a person can put any earlier one back in one tap. That makes an
  assistant's write recoverable, not safe: a write is live in every connected assistant at once, and
  history cannot undo an email already sent on a bad memo. The page shows what changed so a bad write
  is noticed.
- **Peter is a user like any other.** His memos move into the store. The repository keeps the
  code and the templates. His local agents read his memos from the production server over MCP,
  like every other assistant; there is no copy in the repository or in `~/.agents/skills` (Peter,
  2026-10-29). At the cutover the `email-voice` and `working-style` skill links and `recipes/` are
  removed, so no agent reads a stale copy beside the live one.

### Naming: TPS Report and memos

The core memo is **TPS Report**, served by dedicated `get_tps_report` and
`update_tps_report` tools and `/tps-report`, exported once as root `TPS.md`.
Its immutable identity and internal `vibes` key/tag prefix stay unchanged; no TPS
migration is needed. Ordinary `tps` and `tps-report` slugs remain independent.
All other objects are memos, in product, code, and physical database.
Memos express instructions/preferences, never factual or project memory.

The physical recipe-to-memo rename uses exact reviewed 0005 and coordinated
maintenance. Block and drain old callers, verify schema and journal, promote the
final app, refresh clients, then reopen. Old URLs and browser create/save/delete
forms return 404 with no replay. See server/README.md for cutover, uncertain-outcome
checks and rollback; an app rollback can restore old policy despite data compatibility.

### What a user gets

A new account starts with only empty permanent TPS. Unfinished revision-0 accounts
initialize only a missing core (or restore a legacy archived core) in the current
tenant-locked transaction and commit revision 2 with it. Existing content and
completed accounts remain intact, including existing email-voice memos.
The read-only app shows TPS, ordinary memos, archived ordinary memos, history/diffs,
usage and downloads. Agents author all content. The person can Archive/Restore an
ordinary memo or restore a stored version of either ordinary memos or TPS.

### Memos

A memo has a fixed slug, one-line description, Markdown body and immutable versions
with attribution and reasons. TPS is permanent, always active and may be empty.
Archived ordinary heads are excluded from every assistant read, list, search and
error body. Direct reads return not_found; archived write refusals expose only
name/version/archive metadata. The owner can still read the body/history and restore
it in the app. Restoring a stored version creates a new version, keeps intervening
history and copies exact stored body/description. Ordinary source archive state is
preserved; TPS recovery stays active, including from legacy archived sources.

### Tools

| Tool                                                              | What it does                                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `get_tps_report()`                                                | Read/repair TPS; public title, description, body, opaque version, active flag and template status.               |
| `update_tps_report(text, reason, expected_version, description?)` | Append a fenced TPS version; empty text allowed, no name parameter.                                              |
| `tps_check()`                                                     | Static preference-drafting guide; no model call or write.                                                        |
| `check_draft(draft, name?)`                                       | Exact draft, active TPS and optional named memo, plus an assistant review guide; no model call or content write. |
| `list_memos(cursor?)`, `get_memo(name)`                           | Active ordinary memos, versioned and paginated.                                                                  |
| `search(words, cursor?)`                                          | Literal case-insensitive search; distinguish TPS title hits from ordinary name hits with kind.                   |
| `create_memo(name, description, text)`                            | New ordinary version 1; existing names are never overwritten.                                                    |
| `update_memo(name, text, reason, expected_version, description?)` | Append an active ordinary version with full immutable-ID/version fencing.                                        |
| `archive_memo(name, reason, expected_version)`                    | Append an archive version; return only name/version/archive metadata.                                            |

Old core and recipe tool names have no aliases. Attempted calls still count.
The stable internal core key is refused by generic memo tools. A stale TPS conflict
uses the public TPS snapshot, with no name field. Browser recovery accepts no free-form
content and preserves CSRF/origin/session, tenant, immutable-ID and source-version
fences. Errors rerender read-only canonical views with a fresh head and accurate status;
failed rereads expose no stale body/fences. Uncertain writes are never blindly retried.

Read TPS before working and a relevant ordinary memo. Offer setup once when unset.
Use explicit available working preferences first, ask useful follow-ups, or start
with the questionnaire if none are available. Milton cannot inspect another assistant's
memory. Show the full draft, obtain approval, save with update_tps_report and confirm
only after success. Preserve the draft and report rejected/conflicting/uncertain writes
honestly. General working preferences go to TPS; task instructions go to ordinary memos.
After person recovery, read the new head before another assistant write.

Before showing a draft, use `check_draft` and revise against the returned rules.
The assistant judges; Milton supplies versioned rules and a guide, not a verdict.
Coverage is TPS plus the optional named active ordinary memo, never an implied check
of every memo. Drafts are nonblank UTF-8 text up to 32 KiB, with no NUL; the request
limit still applies. The draft is returned unchanged and not persisted or logged by
the application. This read counts toward attempted calls, not writes. Empty TPS
supplies no default preferences. Missing/archived TPS must be read through
`get_tps_report` to repair it; draft checking never repairs or authors content.

### Who may write

For the MVP every assistant the person connects can read and write (Peter, 2026-10-29). Neon Auth's
managed OAuth provider has fixed scopes (`openid`, `profile`, `email`, `offline_access`), so there is
no `read` or `write` scope to grant: a valid access token for Milton's resource from a signed-in user
is the permission. Assistants still cannot delete or revert, every write is a kept version, and the
page shows each write with its client. Per-client permissions, stored in Milton and switched on the
page, are the later answer if they are wanted. Cutting a disconnected assistant off before its
token expires is after the MVP (TODO #1). The page has its own
signed-in browser session (expiry, logout, request forgery protection), separate from the OAuth
provider's transient cookies; stored recovery needs it. Memo text is rendered
as text, never as HTML.

### Identity

A Milton user has an immutable id of its own, with no colon in it, and one or more identities:
`github` with GitHub's numeric id today, `google` with Google's `sub` later, never an email address.
The registry maps (provider, subject) to a user uniquely and transactionally: concurrent first
sign-ins cannot create two accounts or link one identity to two users; seeding
the templates is repeatable. The OAuth provider's token carries the Milton user id, and every tool
reads the caller from it. Sign-in is split in two: the provider step proves an identity; the account
step looks it up or creates it. A second identity is linked only by a signed-in user from the page,
with the provider, the session and the intended account held server-side during the flow; an identity
already owned by another user is refused.

### Tenant boundary

Every request derives one store accessor from the validated Milton user id in the token or the page
session, and nothing else: no caller-supplied user id, no shared memo cache, no global memo
collection as version 1 has. Reads, search, history, downloads and the page all go through that
accessor. A store that cannot run a cross-user query would be a second wall; version 2 relies on the access
layer, and revisits per-user stores later (decision 2).

### Caps, not logs

Per user: 100 ordinary memos including archived ones (TPS is exempt), 32 KB of UTF-8 body text, a name of up to 64 bytes and a
description of up to 500 bytes, 500 bytes of reason, 1,000 tool calls and 100 memo updates a day, reset at midnight UTC. Request bodies are capped at 64 KB before parsing; list, search and history answers come in pages of 50. The daily allowance counts MCP calls; the page has no request limit of its own in the MVP. Retained history is counted in bytes per user and capped at 64 MB; past the cap new text is refused with a clear message, while reverts and restores still go through and do not count against the daily cap, so recovery is never blocked; history is never discarded silently. Per-minute and per-address limits are left to the
host's firewall, and client registration to Neon Auth. Archive keeps the normal daily/history ceilings; only stored recovery is exempt. The OAuth provider's own lifetimes apply to client
registrations and grants; the page lists the user's grants and revokes them, and never deletes a
client registration another user may share. The caps are configuration.

### Download

The page offers one download: a zip with `TPS.md` at the top and the current, unarchived ordinary memos, each a `SKILL.md` folder in
the Agent Skills format, built from one consistent snapshot. There is no export to GitHub and no
local copy kept in step; an assistant that needs the memos connects to the server (Peter,
2026-10-29).

### Decision 1: when an assistant writes

- A. **Direct and versioned.** The write is current at once. The page keeps every version, lists the
  changes, and one tap puts an older one back. Cost: a bad write is live everywhere until noticed.
- B. **Held until seen.** The write waits as a pending version until the person accepts it on the
  page. Cost: every assistant write needs a tap, and an assistant cannot rely on its own change.

Chosen: A. B comes back only if use shows a need, which is how Peter decides new rules.

### Decision 2: where a user's memos live

- A. **One Durable Object per user**, each with its own SQLite database. Stronger separation of memo
  storage: no SQL query can span users. Cost: per-object schema changes, a registry to walk.
- B. **One shared database** with the user id on every row behind a mandatory tenant access layer.
  Simpler to run and to change at a few hundred users.

Chosen: B, as one Postgres database on Neon (decided 2026-10-29, after a first landing on Cloudflare
D1 the same evening). Peter's reason for B was rapid iteration on the data model; Neon adds real
transactions, branches to try a schema change on a copy, Drizzle migrations and the Neon tooling the
team already uses. The Worker reaches it over the network with a connection string held as a secret.
The services connect as a role that reads and writes rows but owns nothing, so the triggers that guard
the data hold against them; only migrations run as the owner (0024).
The tenant access layer is the wall, and the same layer makes a later move to A mechanical. The
stateless MCP handler stays. Neon Functions were looked at and left for later: in beta, and Milton's
sign-in rests on Cloudflare's OAuth provider.

### Recovery

Neon's point-in-time history for the whole branch is the backup (the retention is a project setting).
A separate daily export waits until there are users enough to need it (Peter, 2026-10-29).
Rehearsals run on a throwaway Neon branch made from production and deleted afterwards, never on the
production branch. Before sign-ups open, a rehearsal with two users on Vercel's preview checks
isolation, concurrent edits with conflicts, uncertain writes, stored recovery, Archive/Restore and old-token handling.

### Cost

Neon is already on a paid plan (Peter, 2026-10-29), and the server runs on an existing Vercel plan, so
sign-ups add no new bill. Workers Paid is not needed: the Worker and its key-value store retire with
the moves to Neon Auth and Vercel, both before sign-ups open.
No sign-up cap anywhere, hosted or self-hosted (Peter, 2026-10-30). Sign-ups are open and the only mode; the allow-list and closed modes are gone (Peter, 2026-11-03).

### Sign-in moves to Neon Auth

Decided 2026-10-29, after the store moved to Neon: Milton stops running its own OAuth server. Neon's
Managed Better Auth, with its OAuth provider plugin (beta since 2026-10-23), is the authorization
server for `https://mcp.meetmilton.com/mcp`. MCP clients onboard with Client ID Metadata Documents,
and dynamic client registration is switched on for the clients that need it. Users live in the Neon
project beside the memos; GitHub login is a provider toggle there, Google another. The Worker
becomes a resource server: it checks each access token's signature, issuer and audience and reads
the user from it; the OAuth provider library, the KV namespace, the GitHub upstream code and the
consent handshake go. Milton hosts the two pages Neon does not provide, login and consent, on the
Worker, in Milton's look. Accounts stay in Milton, keyed on the Neon user id.
Every client re-authorizes once. The previous sign-in code stays in git as the fallback while the
beta settles.

Order: the store port lands first, then this, as its own step, before the write tools, so write
scopes are designed once.

### The server moves to Vercel

Decided 2026-10-29, as the step after sign-in moves to Neon Auth. Once the Worker is only the MCP
server, the tools, the tenant store on Neon, token verification and two pages, it is plain Node code
and runs as a Vercel Function in this repository, next to the site: Vercel's MCP handler or the SDK's
own transport, the same host and origin checks, the pages as routes, the Neon connection string and
issuer as sensitive environment variables. `mcp.meetmilton.com` is repointed from the Worker to
Vercel; the MCP server URL registered with Neon Auth does not change. Then the Worker, the KV
namespace and the Wrangler configuration are deleted, and Cloudflare keeps DNS only.

Milton stays on an existing Vercel team for now (Peter, 2026-10-29); a Milton team of its own comes
when Milton has users worth the plan. Order: store port, Neon Auth, then this, straight after (Peter, 2026-10-29).

### Migration from version 1

Production cuts over once, after the store, Neon Auth and the Vercel move are all built (Peter,
2026-10-29). Until then it stays on version 1, the Worker with bundled memos.

1. Build the store, Neon Auth sign-in and the Vercel Function. Production keeps reading the bundled memos.
2. On Vercel, Peter signs in, which creates his account; his two memos are imported, and the import is checked
   against the files byte for byte.
3. Reads switch to the store. Version 1 tokens carry a GitHub id and not a Milton user id, so they
   stop working and clients re-authorize once; the bundle is removed only after reads are verified.
4. Write tools, history and revert, enabled only once the page's revert works.
5. Privacy policy and terms pages on `meetmilton.com` (done 2026-10-30; Google brand verified, so its screen says "continue to Milton"); sign-ups opened; onboarding on `meetmilton.com`.

There is no rollback plan (Peter, 2026-10-29): once the Vercel deployment is verified, the retired pieces (Worker, KV, Wrangler configuration, old sign-in code) are deleted as the work moves on. A disaster restore uses Neon's point-in-time history and names its recovery point. Neither redeploys the bundled memos over newer writes.

### A principle: memos are portable

A memo is a plain Markdown file in the Agent Skills format, readable by any tool that loads
skills. Everything Milton adds, history, authorship, caps, usage, lives beside the file, never inside
it. Download, import and a per-client token for products that cannot speak MCP are that principle
applied. Milton must never grow a feature that makes a memo work only inside Milton.

And a memo is an instruction, never memory. Facts about projects, people and events belong to the
memory products, a crowded market Milton stays out of; a memo says how the person wants a kind of
thing done. Tools, templates and copy keep to that side of the line.

### Teams later

Memos belong to the user directly; there is no owner layer in version 2 (Peter, 2026-10-29). Teams
get their own design when they are wanted: members, roles, sharing and whose vibes apply.

### After the six steps, in this order

1. **Import as onboarding.** A new user pastes or uploads their existing custom instructions or a
   memory export from ChatGPT, Claude or Gemini, and Milton drafts their first vibes memo
   from it, for them to edit. An empty account becomes useful in a minute.
2. **Search that finds meaning.** All-words matching replaces the literal phrase first; semantic search
   through Workers AI embeddings follows.
3. **Links between memos.** A memo can point at another ("see email-voice") in a form the tools
   follow, so an assistant picks the right memo.
4. **A memo as a page for a person.** The same memo rendered read-only at a link you can send, for
   a new colleague or a contractor.
5. **Memos as tests.** Score a draft against the memos it should follow, and tell the person which
   assistant drifts; needs the write tools, history and a model call.
6. **Policy for agents that act.** Memos that say what an assistant may do without asking: limits,
   contacts, when to stop. The same object, read before an action rather than before a draft.

Looked at and left out: automatic extraction of memories from conversations and background rewriting
of them, which would have assistants follow things the person never said; knowledge graphs and
connectors to mail or drives, off the thesis at ten memos a person.

### Not in version 2

Sharing memos between users, teams, payment, Claude Duet, a memo format other than Markdown,
renaming a memo.

## Hybrid hosting and runtime

The selected hosting architecture uses Hono JSX and Vite assets for the browser app and
Hono MCP on separate Cloud Run services. The public Astro site stays on Vercel. Neon PostgreSQL and
Neon Auth remain unchanged. Bun installs, builds and tests; Node 26 LTS runs deployed
server code. Separate dotenvx payloads use platform-held private keys.

The app and MCP are migrated. The private spend-alert worker and its scheduler are
removed with migration 0023. Their canonical URLs and Neon identity remain
unchanged. The [hosting runbook](server/deploy/README.md) defines release checks and rollback.
The retired Vercel app/MCP project and migration validation services are decommissioned;
there is no Vercel backend failover. Preserve the current Cloud Run revisions, pinned
images and secret versions. Future runtime rollback uses Cloud Run revision traffic,
never older instruction or TPS data. This supersedes earlier server-hosting plans.
