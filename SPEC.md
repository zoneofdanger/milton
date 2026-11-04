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
append-only table; every approved sample stays, and reports serve the newest two per kind.
Assembly is deterministic and runs on read: the cover sheet is its rules in
write-once insertion order, after one fixed note on the `Baseline: ` prefix while any
active rule carries it; each report prints its heading, its when line, its
newest two samples of each kind, newest first, then its rules (0017). Every rule prints as one bullet, with
one stored leading `- ` dropped first so rules filed by the retired compiler and rules
stored as sent read alike. Card text cannot contain Markdown
headings. The version is a fingerprint of the assembled cover sheet and reports
(with sample IDs and kinds), so the same cards and samples always give the same
version and every save fences on what the assistant read. The memo group tables (0016) remain as history only.

Filing is correctable (0020): a card's report (or `cover`) lives on each version, so
an explicit `moves` entry appends a version that keeps the card's identity, text and
history; no card moves to tidy up. Samples belong to stable, immutable
kinds named once per report; assistants reuse a `kind_id` from `get_report` and use
`new_kind` only when none fits. `replaces` and `retire_samples` retire samples on
request, and nothing retires a sample automatically; every retirement is reported in
`samples_retired` and recorded with its reason and request. Kind labels
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
and whose `after` is empty retires it. All fields resolve against one locked snapshot
and apply atomically. Anchors resolve uniquely within active card bodies, never
against generated text; overlapping edits fail. The source/report fences, receipt and
replay, history, size and heading limits still apply; reservation is always zero. A
report exceeding its bound refuses the entire save; source instructions are never
truncated. There is no separate save allowance: the 1,000/day attempted-call limit
bounds saves and reads alike; retained history has no cap (0030). A save runs in one
transaction, takes only the account lock and reads `store_config` without locking it.

Removing the model removes paraphrase drift, not interpretation risk: the assistant
picks the report and wording, and a free-text correction sent as a new rule leaves
two rules that disagree. Nothing detects that; the instructions require exact_edits
for every correction.

History belongs to internal instruction cards; legacy memo history is retained. The
cover sheet and reports keep only a current snapshot and a version. The website shows
them and downloads TPS.md; it exposes no memo-management or history/recovery UI. There are no legacy tool aliases or
compatibility rollout paths. See server/README.md for the current contracts,
configuration, migration and local verification instructions.

The web report offers viewing and TPS.md download only. Report refinement (preview,
Apply and Discard) has been removed; its routes return 404. Wording changes go through
`create_memo`, including `exact_edits`. Historical refinement receipts and accepted-change
records stay in the database unchanged.

A read assembles the documents from cards and samples in one statement, takes no
lock and writes nothing; nothing assembled is stored, so there is no refresh step.

Migration 0008 conservatively carries each complete legacy memo into one card,
keeping IDs, versions, source order, exact text and all old history. No model splits
existing instructions. Cards organize and narrow edits; they do not establish semantic correctness.

Accepted changes now retain the exact submitted purpose, rules and edits, actor, affected card
versions and transformation identity atomically with source, history and the report snapshot. These internal
records follow the account-deletion policy, with no history cap. Missing legacy
request evidence remains unavailable.

No sign-up cap anywhere, hosted or self-hosted (Peter, 2026-10-30). Sign-ups are open and
the only mode; the allow-list and closed modes are gone (Peter, 2026-11-03).

One shared Postgres database on Neon holds every account, with the user id on every row
behind a mandatory tenant access layer. The services connect as a role that reads and
writes rows but owns nothing, so the triggers that guard the data hold against them; only
migrations run as the owner (0024). Neon's point-in-time history for the whole branch is
the backup (the retention is a project setting). Rehearsals run on a throwaway Neon branch
made from production and deleted afterwards, never on the production branch.

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
Hono MCP on separate Cloud Run services. The public Astro site stays on Vercel. Neon PostgreSQL and
Neon Auth remain unchanged. Bun installs, builds and tests; Node 26 LTS runs deployed
server code. Separate dotenvx payloads use platform-held private keys.

The app and MCP are migrated. The private spend-alert worker and its scheduler are
removed with migration 0023. Their canonical URLs and Neon identity remain
unchanged. The [hosting runbook](server/deploy/README.md) defines release checks and rollback.
The retired Vercel app/MCP project and migration validation services are decommissioned;
there is no Vercel backend failover. Preserve the current Cloud Run revisions, pinned
images and secret versions. Future runtime rollback uses Cloud Run revision traffic,
never older instruction or TPS data.
