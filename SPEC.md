# Milton: spec

## Current build: memos, tweaks, the cover sheet and reports

Product direction comes from the memos-and-tweaks spec of 2026-11-09 (kept with the
agents' working notes, not in this repository); where this section and that spec
differ, this section records the code as built. Its vocabulary applies here:

- A **memo** is one piece of writing Milton keeps: the AI's first draft, the final the
  person accepted, and the tweaks between them. Writing the person pastes or asks the AI
  to remember is a memo with only a final. `create_memo` does what its name says.
- A **tweak** is one line about what the person made the AI change, with its condition
  where known ("vendor replies: no warm-up opener").
- The **cover sheet** is the person's own voice guide, written only by them.
- A **report** is what Milton assembles for one draft: the cover sheet, the
  best-matching finals as **examples**, then the tweaks. There are no fixed reports.
- "Did you get the memo?" means "have you read the writing I've settled on?"

Rules, samples, instruction cards, the five fixed reports, `list_reports`, exact edits,
moves, session capture, the sample offer and rule-after-twice are gone, with no aliases.
User-facing copy says "memo", "tweak", "cover sheet", "report" and "AI".

Saves are model-free: the AI writes the tweaks and the context summary, and Milton
stores the bytes it is sent, computes a tier and a change score with plain code, and
counts tweak citations. Reads are model-free too.

### Tools

Agents use three tools.

- `get_cover_sheet` takes no arguments and returns `text` (the cover sheet), `version`
  (an integer, 0 before any), `memos` and `tweaks` (counts), `keep_memos` and `is_empty`
  (no cover sheet text and no memos), plus the setup script while empty.
- `get_report` requires `intent: {situation, medium, audience, purpose, kind_id?}`:
  a one-line situation (at most 200 characters), a medium (`email`, `chat`, `post`,
  `document` or `speech`), audience and purpose (one line, at most 100 characters each,
  required because vague intents rank worse), and a kind from the person's kinds. It
  returns `report_id`, `text`, `is_empty`, `examples` (memo id, kind, medium, tier and
  date, in served order), `tweaks` (`{tweak_id, text, memos}`) and `kinds` (every kind
  on the account).
- `create_memo` takes a UUID `request_id` and exactly one of `memo` (with an optional
  `memo.report_id` from the read before the draft), `cover_sheet`, `forget_memos` or
  `memo_context`.

Precedence when guidance disagrees: what the person says now, then the cover sheet,
then tweaks, then examples. Nothing widens an edit's scope.

### What a memo holds

A memo keeps two texts word for word: the first draft, exactly as the AI first showed
it (in edit mode, its first edit of the person's text), and the final the person
accepted, hand edits included. If the AI no longer has the first draft verbatim, it
sends `first_draft_missing` instead of rebuilding it. With either, `mode` (`draft` or
`edit`) and `rounds` (redrafts after the first draft) are required; with neither, the
memo is final-only (setup pastes, "remember this") and takes no mode, rounds or tweaks.
Each text is at most 256 KiB; the whole request has the existing 256 KiB cap.

The AI also sends a context: a one-line placeholder-safe `summary` of the situation and
the text replied to (never the quoted text), `medium`, and optional `audience` and
`purpose`, plus a kind (`kind_id`, or `new_kind`, reused by label in any letter case).
Kinds belong to the account. Milton records the AI, the time, the change score, the
tier and the `report_id` with the tweaks that report served, so the TPS page can show
what was served without relying on the AI. Not kept: intermediate drafts, the person's
correction messages, the ask, and other people's text.

A save whose final and first draft are already on file returns `unchanged` with that
memo, so a repeat never counts its tweaks twice.

**When a memo is saved** is AI guidance, not server enforcement: the instructions tell
the AI to save without asking when the person accepts a final (approves it, says it's
done or they'll send it, or copies it to use), untouched finals included, and not to
save abandoned drafts, writing not in the person's own voice, or when they ask it not
to. After a saved result the AI tells the person the result's one-line receipt, with no
question ("Kept memo: vendor decline, 2 rounds, tweaks: no warm-up opener."; "your
words" in place of rounds for a final-only memo, at most three tweaks, then "and N
more"). Whether the line shows depends on the client. No hook or plugin is involved;
fidelity and capture rate are measured per client before any claim of reliability.

### Tiers and examples

Milton sets each final's tier at save, from the memo's source alone:

- **your words** (`own`): final-only memos and edit-mode memos;
- **steered by you** (`steered`): drafted memos whose final differs from the first
  draft, or, with the first draft missing, that had at least one round;
- **accepted untouched** (`untouched`): drafted memos whose final equals the first
  draft, or, with it missing, that had no rounds. Untouched finals are never served;
  they count only on the scoreboard.

A report ranks every memo by requested kind, medium match, tier (your words before
steered), word overlap of purpose and audience, full-text rank of the situation against
summary, purpose, audience and final, recency, then id. Examples fill by rank within a
32 KiB budget, a block that doesn't fit is skipped for the next, and the top one is
always served. At most 3 steered finals are served per report, and finals over 128 KiB
are kept but never served. There is no deliberate variety rule.

### Tweaks

Tweaks come from the AI in the same `create_memo` call, only when the final differs
from the first draft: one line each, at most 200 characters, at most 10 per memo.
`{tweak_id}` reuses a tweak the account has; `{text}` is normalized (Unicode NFC, lower
case, collapsed spaces, trailing punctuation dropped) and reuses an exact match, or is
added. Each memo-and-tweak pair is one citation, and a tweak's count is its citations.
A tweak is matched only through the memos that cite it: a report serves the tweaks
cited by the 10 best-ranked memos that cite any, ordered by their best memo's rank,
then citation count, at most 10. (Ranked over all memos, the person's own pasted
writing, which ranks first and cites none, would starve tweaks.) Each read records its
served tweak ids under its `report_id`.

The person can delete a tweak or reword it on the TPS page; a reworded tweak keeps its
id and citations, and a wording another tweak already has is refused.

### The cover sheet

One free-text document per account, at most 1,500 characters, written only by the
person. Every change appends a version; nothing is overwritten, and each change carries
the version it read. The AI changes it only on the person's words ("remember …", "add
to my cover sheet"): it adds one line (at most 300 characters) or removes one exact
existing line, never resends the whole text, and can't empty it. It never adds tweaks
or its own inferences. A correction during a draft is a tweak, not a cover sheet line.
The TPS page's form rewrites the whole text under the same version fence and may empty
it; that form ends "only AIs can save" for this one field. The cover sheet is served
first in every report.

### Scoreboard

The TPS page computes it on read, with no model. Change is normalized token Levenshtein
from the first draft to the final over the longer token count (not computed when the
differing middle exceeds 20 million token pairs). Draft and edit memos are scored
apart, and only memos with a kept first draft and a score count. From 10 memos it shows
medians of rounds and change and the share of first drafts accepted as-is for the
latest 5 against the first 5; from 60 memos, the last 30 days against the 30 before.
Rounds are self-reported, so change is the headline figure.

### Control, retention and deletion

- The TPS page lists the newest 200 memos (older ones stay in the export), opens a full
  memo on demand, forgets one, edits the cover sheet, and deletes or rewords tweaks. A
  memo settings page holds the **Keep memos** switch, on by default. Off, a memo with a first draft is
  refused (`memos_off`); writing the person asks to remember still saves. "Delete all
  memos" removes every memo, tweak and kind, not the cover sheet.
- Forgetting a memo (on the page, or `forget_memos` from the AI) deletes it, its
  citations and any tweak left with none, so its example and scoreboard numbers go too.
- `memo_context` corrects a memo's summary, medium, audience, purpose or kind; a memo's
  words never change.
- Memos are kept until forgotten, deleted with "Delete all memos", or removed with the
  account. There is no timer.
- `TPS.md` holds the cover sheet, the tweaks with counts, and every memo's final grouped
  by medium, newest first. First drafts are not in it.
- Account deletion removes memos, kinds, tweaks, citations, served-report records, the
  cover sheet and its versions, and the switch. `docs/deletion-inventory.txt` lists
  every column.

### Saves

A save runs in one transaction under the account lock: replay a known request ID, or
check the trial gate, apply the change and write its receipt with the outcome, which
commits with the change or not at all. The same request ID with the same input replays
the stored outcome; different input is refused. A refusal rolls back to a savepoint and
its receipt stores it; a transient database failure rolls back the whole save, receipt
included, so the same request can succeed. The web app's own session cannot call
`create_memo`; the TPS page's changes run under the same account lock.

### The release and the wipe

The memo tables ship additively: the old writing tables (cards, card versions, accepted
changes, sample kinds, samples, sample versions, guides) stay, unread by the new code,
until a follow-up migration drops them and wipes that writing. That migration names
the merged PR that stopped reading them in `code-stopped-by`, and milton-duo runs it
from the runbook after a snapshot. It keeps accounts, sign-ins, connection keys,
trials, Stripe state and the end-to-end test account. Every account starts with an
empty cover sheet and no memos and gets the setup offer again; the release note tells
live accounts their writing was reset. There are no compatibility shims or rollback
scripts; the pre-migration snapshot is the rollback. The schema history before memos
(instruction cards, sample revisions, the 0033 cleanup) is in git history and the
hosting runbook.

### Setup

Setup, when `is_empty`, offers once. It first asks for about five pieces the person
wrote and sent, kept as final-only memos (top tier) exactly as pasted, then offers to
start the cover sheet in their words, then the standing line. Setup never reads an
inbox and never blocks a writing task.

### Removed, and unchanged

Embeddings, advisory card graphs, task-aware retrieval and observation-only gardening
were built, measured and removed; their schema is absent from the baseline. What they showed
and what would justify rebuilding any of them is in
[the research note](docs/research/derived-systems-2026.md). The default-off derived-guide
pilot was parked on 2026-11-07 and its code is removed with memos; its tables go with
the old writing.

No sign-up cap anywhere, hosted or self-hosted (Peter, 2026-10-30). Sign-ups are open and
the only mode; the allow-list and closed modes are gone (Peter, 2026-11-03).

One shared Postgres database on Neon holds every account, with the user id on every row
behind a mandatory tenant access layer. The services use distinct auth/app/MCP roles that own nothing, so the triggers that guard the data hold against them; only
migrations run as the owner. Neon's point-in-time history for the whole branch is
the backup (the retention is a project setting). Product rehearsals use a disposable PostgreSQL database and fictional identities. Verified production source-schema/metadata reconciliation remains a separate owner gate; build work does not read private writing.

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
