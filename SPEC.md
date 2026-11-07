# Milton: spec

## Current build: Instruction cards, reports, samples and the cover sheet

Product direction comes from Peter's product note of 2026-11-02 (kept with the
agents' working notes, not in this repository); where this section and the note
differ, the note wins. Its vocabulary applies here: a memo is anything sent to Milton
(a rule, a correction or an approved sample), a report is one assembled document per
writing situation, and the cover sheet carries the rules true of all writing plus the
report index. "TPS Report" and "group" are retired words; they survive only as code
identifiers such as `TPS.md` and `tps_body_limit`. This section records
the contracts as built. Agents use only `get_cover_sheet`, `get_report`, `list_reports` and
`create_memo`. Saves are model-free: the assistant names each rule's
report and sends its exact approved wording, and Milton stores those bytes. Complete
instructions, including conditions and exceptions, are independently versioned cards. Each card belongs to one of five fixed
reports (`email`, `chat`, `post`, `document`, `speech`) or to the cover sheet, the
rules true of all writing. Approved samples are stored exactly as sent in their own
table with immutable writing; every approved sample stays, and a report read serves the eight that best
fit the assistant's intent.
Assembly is deterministic and runs on read: the cover sheet is its rules in
write-once insertion order, after one fixed note on the `Baseline: ` prefix while any
active rule carries it; each report prints its heading, its when line, selected samples,
then its rules (0017). `get_report` requires an intent (a one-line situation, with an
optional personal kind and context dimensions) and serves up to eight samples ranked by
requested kind, purpose overlap count, exact dimension match count, Postgres full-text
rank of the situation against context summary and body, recency, then ascending ID.
Broader examples fill sparse matches, with exact match evidence and a fallback explanation;
unknown scope stays unknown and excerpts do not establish whole-work structure.
The `get_report.kinds` index lists every personal kind with an active sample in that
report as `{kind_id, kind}`, ascending by ID, independently of intent or the eight-sample
selection. It includes older unserved kinds without sample bodies; empty and retired-only
kinds and other accounts/reports are excluded.
Without an intent (`list_reports`, the web page) a report serves its
newest eight (0033). The TPS.md download includes all active approved samples, newest
first. Every rule prints as one bullet, with
one stored leading `- ` dropped first so rules filed by the retired compiler and rules
stored as sent read alike. Card text cannot contain Markdown
headings. The version is a fingerprint of the assembled cover sheet and reports
(with every active sample's ID, kind and sample revision), the same for every intent, so the same cards and samples always give the same
version and every save fences on what the assistant read. The memo group tables (0016) remain as history only.

Filing is correctable (0020): a card's report (or `cover`) lives on each version, so
an explicit `moves` entry appends a version that keeps the card's identity, text and
history; no card moves to tidy up. Samples belong to stable, immutable
kinds named once per report; assistants reuse a `kind_id` from `get_report` and use
`new_kind` only when none fits. Every sample requires approved context: representation
`version: 1`, a useful summary, and optional known purposes, medium, audience
relationship/role/familiarity/expertise/group, interaction, whole/excerpt scope with
optional excerpt role, language and register. Keys are fixed; vocabulary values are
bounded strings, so unfamiliar kinds and purposes require no migration. Unknowns stay absent.
Each sample has one stable tenant-scoped identity in `samples`, with original creation
time and actor, and complete immutable snapshots in `sample_versions`. The latest
revision alone is current. `sample.sample_id` revises an active identity with complete
approved text, context and report/kind; omit it for a new example. The old `replaces`
input is removed. Classification corrections use the same revision, resolving kind
and report together. `sample_context` appends a complete snapshot preserving body and
identity, optionally reclassifying within the same report; omitted context fields
clear. It cannot combine with `sample` or `retire_samples`.

An identical revision appends nothing. New examples deduplicate only against a complete
identical active example: body, report/kind and JSON context. Different context can
justify separate examples. Revisions never merge identities, even when two examples
end up identical. Every changed revision fences account saves, including examples
outside the served eight. Request retries replay the same receipt; mixed rule/sample
changes apply together or not at all.

`retire_samples` explicitly appends an inactive snapshot of each named active stable
ID, reported in `samples_retired`; revisions are not retirements. Reads, the app and
exports use current active snapshots only, with no history/restore UI. Report metadata
exposes stable `id` and `revision`. Approval date and sample recency use the latest
revision time, including context/classification corrections; original creation stays
separate. Other ranking tiers and report/category vocabulary are unchanged. Kind
labels stay out of report text.

Embeddings, advisory card graphs, task-aware retrieval and observation-only gardening
were built, measured and removed; their schema is absent from the baseline. What they showed
and what would justify rebuilding any of them is in
[the research note](docs/research/derived-systems-2026.md).

Assistants offer to save a sample on approval and a rule on repeated correction, each
only with the person's yes; no automatic capture. Closed-client execution and actual
instruction adherence remain outside the server's guarantee.

Every save is exact. `create_memo` needs at least one structured field: `rules`
(1 to 100 entries of `{ report, text }`, `report` one of the five or `cover`),
`exact_edits`, `moves`, `sample`, `sample_context` or `retire_samples`. A save with none is refused
with `invalid_input` ("Name the report and send the rule's text in rules."). Each
`rules` entry becomes one new card stored byte for byte; its description is its first
non-blank line, trimmed and cut to the description cap, with no model. An entry whose
text prints like an active card in the same report, or an earlier entry in the same
request, is skipped; a save that then changes nothing returns `unchanged` and charges
nothing. `text` is the stated purpose: recorded with the accepted change, never stored
as a rule. A rule stored starting with `Baseline: ` must match the historical
setup catalog byte for byte, in its canonical report (`baseline_unknown` otherwise).
The default setup is now sample-first: empty accounts offer it once, and empty
reports carry optional help. Rules or samples make guidance usable; no quiz or
rule count gates drafting. The assistant preserves existing guidance, shows exact
placeholder-safe samples, obtains explicit retention approval for each, saves and
reads back, then helps draft the next real task matching the report; the entry
prompt favors email or DM. Every sample save displays exact text and proposed useful,
non-private context together; one retention approval covers that proposal. Unchanged
approved metadata needs no second approval; changed text or context, including redaction,
requires renewed approval. Sending or praise is not retention approval. Skipping examples does not
block drafting. Setup does not authorize mailbox access, import, account changes
or saving unseen text. A standing instruction is offered separately with consent. Corrections go through `exact_edits`; an edit whose `before` is a whole rule
and whose `after` is empty retires it. All fields resolve against one locked snapshot
and apply atomically. Anchors resolve uniquely within active card bodies, never
against generated text; overlapping edits fail. The source/report fences, receipt and
replay, history, size and heading limits still apply; reservation is always zero. A
report exceeding its bound refuses the entire save; source instructions are never
truncated. There is no separate save allowance: the 10,000/day attempted-call limit
bounds saves and reads alike; retained history has no cap (0030). A save runs in one
transaction, takes only the account lock and reads `store_config` without locking it.

Removing the model removes paraphrase drift, not interpretation risk: the assistant
picks the report and wording, and a free-text correction sent as a new rule leaves
two rules that disagree. Nothing detects that; the instructions require exact_edits
for every correction.

History belongs to internal instruction cards; obsolete memo tables are removed by the
repository cleanup. The
cover sheet and reports expose only the current documents and a version. The website shows
them and downloads TPS.md; it exposes no memo-management or history/recovery UI. There are no legacy tool aliases or
compatibility rollout paths. See server/README.md for the current contracts,
configuration, migration and local verification instructions.

The web report offers viewing and TPS.md download only. Report refinement (preview,
Apply and Discard) has been removed; its routes return 404. Wording changes go through
`create_memo`, including `exact_edits`. Historical refinement receipts and accepted-change
records stay in the database unchanged.

A read assembles the documents from cards and samples in one statement, takes no
lock and writes nothing; nothing assembled is stored, so there is no refresh step.

Fresh installations apply the baseline, `0001_sample_context` and
`0002_sample_versions`. The forward sample revision migration maps ordinary replacement
chains to root IDs and keeps every known body, context, classification, actor and date;
legacy IDs, context counters and retirement evidence live in revision provenance.
Retired leaves stay inactive; dedup-consolidated roots without successors remain
separate retired identities. Accepted-change evidence remains unchanged. Earlier
context values/correction times were not stored and are not invented: each legacy row
contributes only its last known snapshot, dated by its known creation (or leaf
retirement), with this limitation recorded in provenance. Backfilled revision numbers
count known snapshots, not missing context edits. Ambiguous lineage (cycles, branching,
invalid/cross-account or cross-report parents, incompatible parent lifecycle) aborts
transactionally before dropping old columns.

This breaks schema and sample API compatibility. An authorized release must close
reads/writes, drain old instances, snapshot, migrate and start compatible app/MCP code
as one cutover; old runtimes must never use the new schema. Reconnect assistants and
reread guidance/IDs/version before saving. No compatibility shim or rollback artifact
is part of this change; no migration or release is authorized by implementation alone.
An owner-only, atomic one-time transition supports the known 0033 schema; it
drops the unused memo layer and preserves card identities, every card version and
all other current data. Other old schema states are refused. Production applied this
cleanup on 2026-11-04; the hosting runbook records its snapshot and verification.
Cards organize and narrow edits; they do not establish semantic correctness.

Accepted changes now retain the exact submitted purpose, rules and edits, actor, affected card
versions and transformation identity atomically with source and history. These internal
records follow the account-deletion policy, with no history cap. Missing historical
request evidence remains unavailable.

No sign-up cap anywhere, hosted or self-hosted (Peter, 2026-10-30). Sign-ups are open and
the only mode; the allow-list and closed modes are gone (Peter, 2026-11-03).

One shared Postgres database on Neon holds every account, with the user id on every row
behind a mandatory tenant access layer. The services use distinct auth/app/MCP roles that own nothing, so the triggers that guard the data hold against them; only
migrations run as the owner. Neon's point-in-time history for the whole branch is
the backup (the retention is a project setting). Product rehearsals use a disposable PostgreSQL database and fictional identities. Verified production source-schema/metadata reconciliation remains a separate owner gate; build work does not read private writing.

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

## Hybrid hosting and runtime

The selected hosting architecture uses Hono JSX and Vite assets for the browser app and
Hono MCP and self-hosted native auth on three separate Cloud Run services. The public Astro site stays on Vercel; PostgreSQL writing/billing identity stays stable. The prepared auth replacement requires a coordinated owner-verified cutover; it is not a record of a live release. Bun installs, builds and tests; Node 26 LTS runs deployed
server code. Separate dotenvx payloads use platform-held private keys.

The app and MCP are migrated. The private spend-alert worker and its scheduler are
removed with migration 0023. App and MCP canonical URLs remain unchanged. Auth has its own host, issuer and runtime role; exact verified issuer/subject maps to retained internal account IDs through owner-verified metadata. App OIDC sessions and MCP native bindings have separate authority. The [hosting runbook](server/deploy/README.md) defines release checks and rollback.
The retired Vercel app/MCP project and migration validation services are decommissioned;
there is no Vercel backend failover. Preserve the current Cloud Run revisions, pinned
images and secret versions. Future runtime rollback uses Cloud Run revision traffic,
never older instruction or TPS data.

## Default-off derived-guide pilot

Approved saves remain model-free. Explicitly opted-in eligible paid/trial accounts may
also receive a separate, derived per-report guide from all active approved samples and
complete context. Background Anthropic processing never changes approved sources or
save fences. Reads include an optional self-contained guide/status block; explicit rules,
Baseline precedence and requested edit scope still govern. Stale successful guides remain
labeled until replaced; zero samples and valid insufficient evidence clear them. Operator
controls, spend/retry limits, eligibility and service capabilities are specified in
[guide operations](server/deploy/guides.md). No public tier, new MCP tool, history UI,
refresh/disable control or rollout authorization is introduced.
