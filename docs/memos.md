---
name: memos
description: What a memo, tweak and report are; what a memo holds, its tier, change score and tweaks; kinds, legacy data and when AIs save
type: behaviour
covers:
  - server/src/store/score.ts
  - server/src/store/save.ts
  - server/src/mcp-tools.ts
  - server/src/mcp.ts
  - server/src/store/memos.ts
  - server/src/store/tps.ts
  - server/src/http.ts
  - server/src/store/schema.ts
  - server/src/memo-pages.tsx
  - server/test/copy-drift.test.ts
  - server/drizzle/0012_memos.sql
  - server/drizzle/0015_memo_evidence.sql
  - server/src/store/changes.ts
---

# Memos

## Vocabulary

- A **memo** is one piece of writing Milton keeps: the AI's first draft and the final the
  person accepted. Writing the person pastes or asks the AI to remember is a memo with
  only a final. `create_memo` does what its name says.
- A **tweak** is one change the person made to an AI's first draft, worked out by
  Milton's code from the first draft and the final and stored as a change row
  ([Changes](#changes)). No AI writes, sends or labels one. "Tweak" is the person-facing
  word on the TPS page and in TPS.md; served text calls them "What they changed in the
  AI's first draft" ([reports](reports.md#what-they-changed)).
- A **report** is what Milton assembles for one draft: the best-matching finals as
  **examples**, with a few of their tweaks under drafted ones ([reports](reports.md)).
  There are no fixed reports.
- "Did you get the memo?" means "have you read the writing I've settled on?"
- Milton keeps no standing rules: no cover sheet, no notes an AI writes from edits, no
  tweak score and no rounds (Peter, 2026-11-12). Rules crafted automatically from
  recurring tweaks are later work (#41); they would be computed at read and added to the
  report, with no tool change.
- User-facing copy says "memo", "tweak", "report" and "AI". Rules, samples, instruction
  cards, the five fixed reports, `list_reports`, exact edits, moves, session capture,
  the sample offer, rule-after-twice, the cover sheet and AI-written tweaks are gone,
  with no aliases.

Saves and reads are model-free: the AI writes the context summary, and Milton stores
the bytes it is sent, finds what changed, and computes a tier and a change score with
plain code. How a save commits is in [saves](saves.md).

## What a memo holds

- Two texts word for word: the first draft, exactly as the AI first showed it (in edit
  mode, its first edit of the person's text), and the final the person accepted, hand
  edits included.
- The first draft's state: `kept`, `missing` (the AI sent `first_draft_missing` because
  it no longer had the draft verbatim) or `none` (writing the person gave).
- With `first_draft` or `first_draft_missing`, `mode` (`draft` or `edit`) is required.
  With neither, the memo is final-only (setup, "remember this") and takes no mode or
  request. Both together are refused. Shape problems are refused before any database
  work.
- With a kept first draft, the list of what changed ([Changes](#changes)) and its state:
  `itemized` or `too_large`; empty for memos saved before 0015.
- The person's **request**, when the AI sends one on a drafted memo
  ([The request](#the-request)).
- A context: a one-line placeholder-safe `summary` of the situation and the text
  replied to (never the quoted text, at most 200 characters), `medium`, and optional
  `audience` and `purpose` (at most 100 characters each).
- An optional kind ([Kinds](#kinds)), the change score, the tier, the AI (issuer and
  client), the request ID and its times. A new memo's retired columns stay empty:
  `rounds` and `report_id` NULL, `served_tweak_ids` `{}` ([legacy data](#legacy-data)).
- Not asked for: intermediate drafts, the person's correction messages and other
  people's text. The ask is kept only as `request` ([The request](#the-request)).
- A save whose final, first-draft state and first draft match a memo on file returns
  `unchanged` with that memo, adding nothing.
- `memo_context` replaces a memo's medium, summary, audience and purpose (an omitted
  optional field clears) and, when sent, its kind, and sets `context_updated_at`; a
  memo's words, and an older memo's rounds and report metadata, never change. The same
  context returns `unchanged`; an unknown memo is `invalid_memo`.
- With **Keep memos** off, a memo with a first draft (kept or missing) is refused with
  `memos_off`; a final-only memo, writing the person asks to remember, still saves. The
  switch is on by default (no settings row means on).

## Bounds

These are fixed in code and the schema; no memo bound reads `store_config`. Which finals
are served as examples, and their size cap, is in [reports](reports.md#examples).

| What                           | Bound                                           |
| ------------------------------ | ----------------------------------------------- |
| Request body                   | 256 KiB, before parsing ([hosting](hosting.md)) |
| A final or first draft         | 256 KiB UTF-8, non-blank, well formed, no NUL   |
| Summary                        | 200 characters, one line                        |
| Audience, purpose / kind label | 100 / 60 characters, one line                   |
| Request id                     | 64 characters of `A-Za-z0-9._:-`                |
| A stored change, each side     | 300 characters, cut and marked                  |
| Request                        | 600 characters, 12 lines                        |
| Memos per forget               | 100                                             |

A memo's words (its final and first draft) are stored exactly as sent, and its request
as sent less surrounding whitespace ([the request](#the-request)); invalid Unicode and
NUL are refused before a driver could replace them. A one-line field (an intent's
situation, audience and purpose, a memo's or `memo_context`'s summary, audience and
purpose, and `new_kind`) follows the one-line rule instead: each run of the invisible
line and paragraph separators U+2028 and U+2029 becomes one space, then the value is
trimmed and checked against its bound. Control characters left after the trim, an
ordinary line break or tab among them, are refused as before, so a trailing line break
is trimmed away, not refused (Peter, 2026-11-12). A value then holding a bidirectional
control that opens an embedding, override or isolate span (U+202A to U+202E, U+2066 to
U+2069) is refused, never stripped: stripping can change the intended display, and the
plausible sources are pasted or hostile text. U+200E, U+200F and U+061C open no span and
stay accepted. The final, first draft and request are never checked for them, and
stored values are never rewritten. The input is hashed after the rule
([saves](saves.md)).

## Tiers

Milton sets each final's tier at save, from the memo's source alone:

- **your words** (`own`): final-only memos and edit-mode memos;
- **steered by you** (`steered`): drafted memos whose kept first draft differs from the
  final, and draft-mode memos whose first draft is missing;
- **accepted untouched** (`untouched`): drafted memos whose kept first draft equals the
  final. Untouched finals are never served; they count only on the scoreboard.

A missing first draft in edit mode stays `own`. Stored tiers are never recomputed, so a
memo saved before this rule with a missing first draft and no rounds stays `untouched`.

## Change score

- Normalized token Levenshtein (words and single punctuation marks) from the first
  draft to the final, over the longer token count, from 0 to 1.
- Only the middle after a shared prefix and suffix is compared. It is computed only for
  a kept first draft, and left empty when that middle exceeds 20 million token pairs.
- A saved memo's result shows the change to three decimals.

## Changes

What changed from a kept first draft to its final is found by code at save, once,
before any database work: these are the memo's tweaks. The TPS page and the memo page
show them, TPS.md lists them all, and a report quotes a few of them under drafted
examples ([reports](reports.md#what-they-changed)). Nothing is
computed for a missing first draft or writing the person gave. No AI sends or labels
changes: the AI-labelled changes and quote matching the spec proposed were left out
([the spec's follow-up](research/memo-evidence-spec-2026-11-11.md)).

- **Code's list.** Both texts are split into words and single punctuation marks, as the
  change score splits them, and case counts ("Hi" against "hi" is a change, since
  lowercase is a habit). A shared prefix and suffix are skipped, then a Myers diff runs
  on the middle. Edits separated by at most two unchanged tokens on one line are one
  **spot**, so `Hi Dana,` → `Dana —` is one. A spot whose sides differ only in
  Markdown marks (``* _ # ` > ~ |``) and whitespace is about `format`, and is never
  split.
- **Split spots** (#42). Any other spot whose sides are whole lines on one side and the
  end of one kept line on the other is two spots, a cut and an addition at the same
  place. The end of a line starts after a kept token on that line, runs to the line's
  end and holds no line break. So "thx, Sam" cut on its own lines and a sentence added
  after a kept "Saturday." are two spots, not a sign-off swapped for an offer. A
  reflowed replacement of the same shape is split too, on purpose ("Kind regards, Sam"
  on its own lines → "—S" at the end of the line before): layout alone can't tell it
  from unrelated edits, and a cut plus an addition is never false, only less specific,
  while a wrong pairing tells an AI something untrue (decided on PR #133's review). A
  line's end that runs onto more lines stays one spot, since those lines may hold what
  the whole lines replace (a sign-off), and so do whole lines against whole lines (a
  replaced line). Known limit: kept punctuation after a spot stops it ending its line,
  so "Thanks!" → "I can do Sunday!" after a kept line stays one spot. Rows stored
  before this keep the old single spot.
- **Bounds.** Past 100 spots, past the change score's 20 million token pairs or past
  2,000 changed tokens (which bounds the diff's memory to about 16 MB), the state is
  `too_large` and nothing is listed; otherwise it is `itemized`. A test times the diff
  on the largest texts one request can carry, one case per bound; each takes well under
  100 ms.
- **What is stored** (`memo_changes`): one row per spot, in text order, with its UTF-16
  offsets in both texts and its two sides as code cut them from the stored texts. A
  side longer than 300 characters keeps its first 300, with `truncated` set, and the
  memo page marks the cut. A long spot is cut rather than making its memo `too_large`,
  which stays only for the bounds above: whole-spot rows would have pushed 8 of 37
  replayed memos to `too_large`, and a marked cut hides nothing on the memo page. A
  report never serves a cut row. `about` is `format` for a Markdown-only spot, code's
  own marker, and NULL otherwise; `by` and `tweak_id` stay NULL ([database](database.md)).
  No client-supplied change row, label or link is accepted.
- A saved or unchanged result's `memo` carries `changes: {state, found}`: the state and
  the rows that are not format. A save's stored receipt holds only these, never a side
  ([saves](saves.md#receipts)).
- Changes never rank or score anything. Which are served, and how, is in
  [reports](reports.md#what-they-changed).

## The request

- `request` is optional and only on a drafted memo (`first_draft` or
  `first_draft_missing`). It is what the person asked for. When they said what to write,
  the AI is asked to send their instruction exactly as typed, with pasted or quoted
  material and secrets cut and each cut marked `[…]`; in edit mode the instruction, never
  the text to edit; never their later corrections. When they only agreed to the AI's
  offer to write or approved the result, the AI is asked to write one short line on what
  they agreed to, with no pasted or other people's text. That is guidance, not a
  guarantee.
- Peter decided this on 2026-11-13, answering "2 and 1" to two options: the AI writes a
  short line when the person only agreed, and the served rule is worded loosely, with no
  example phrases, for the AI to judge. It supersedes the 2026-11-11 rule
  ([memo-evidence spec](research/memo-evidence-spec-2026-11-11.md), point 4) that a
  request is only typed words: in coding sessions the AI offers to draft and the person
  says yes, so typed-only requests recorded "yes".
- What Milton checks: it is trimmed, then must be 1 to 600 characters and at most 12
  lines, well formed, with no control characters but line breaks. A request that looks
  like quoted or forwarded mail is refused: a line starting `>`, an "On … wrote:" line,
  or a `From:` or `Subject:` header (any letter case). Milton cannot otherwise tell typed
  text from pasted text, so a short pasted body without those lines, or text pasted in
  edit mode, can be kept. These refusals come before any database work and carry their
  own next step.
- It is stored in `memos.request`, part of the hashed input, never in the search vector
  or ranking, and never served to an AI. Only the person sees it, and the TPS page can
  remove it under the account lock ([TPS page](tps-page.md)).
- With Keep memos off, drafted memos are refused, so no request is kept.

## Scoreboard

- The TPS page computes it on read, with no model, from memos with a kept first draft
  and a change score.
- Draft and edit memos are scored apart, since edit memos start from the person's text.
- Below 10 memos of a mode, it shows only the count.
- From 10, it shows the median change and the share accepted as-is (final equal to the
  first draft) for the latest 5 against the first 5.
- From 60, it compares the last 30 days with the 30 before.
- Rounds are no longer shown; eligibility is still a kept first draft and a change
  score, whatever a memo's rounds. TPS.md omits the scoreboard.

## Kinds

- Kinds belong to the account. A memo names one with `kind_id` or `new_kind`; sending
  both is refused.
- `kind_id` must name one of the account's kinds (`invalid_kind`); a memo's
  `kind_id: null` is read as omitted, before the input is hashed.
- `new_kind` (one line, at most 60 characters) reuses a kind with that label in any
  letter case, else creates one. Labels are unique per account in any letter case.

## Legacy data

What earlier versions wrote, which this release stops writing and no longer serves. It
is kept, not converted: TPS.md lists the cover sheet and notes ([TPS page](tps-page.md)),
the deletion paths remove it as before ([deletion](deletion.md)), and historical receipts
replay it ([saves](saves.md#receipts)).

- `cover_sheets`: the person's former voice guide, every version.
- `tweaks` and `tweak_citations`: notes AIs wrote from edits, with the memos that cited
  them.
- `served_reports`: what each earlier report served.
- A memo's `rounds`, `report_id` and `served_tweak_ids`, and `memo_changes.tweak_id`.
- `usage_calls` rows naming `get_cover_sheet`.

No new-version path inserts or updates any of these; deletion and foreign-key actions
still may. The write grants stay, unused, until a later cleanup, on Peter's word, revokes
them and drops the tables and columns; that cleanup deletes the cover sheet versions the
privacy page says are kept.

## What the AI is told

The server instructions ([mcp](mcp.md)) carry this guidance. It is AI guidance, not
server enforcement: Milton cannot see the conversation, no hook or plugin is involved,
and whether the receipt line shows depends on the client. Fidelity and capture rate are
measured per client before any claim of reliability.

- Before writing or editing for or as the person, read `get_report` with an intent.
- Precedence when guidance disagrees: what the person says now, then the examples.
  Imitate examples' wording and heed what they changed.
- When the person says what to write (read-write connection), their words are the raw
  material: reuse their phrases word for word where they fit, add only a greeting, a
  sign-off and connecting words in the manner of their examples, and don't expand on
  what they said.
- Edit mode: change only what was requested and keep the person's other words, length,
  tone, greeting and sign-off; guidance never widens an edit's scope, and changes are
  briefly listed.
- Asked "Did you get the memo?" or "Did you get that memo?", read `get_report` for the
  task even after an earlier read; confirm only after a successful read, and report
  empty results and failures honestly. Quoting or discussing the phrase is not an
  invocation. A read-only connection treats it as a read, never a save.
- Save a memo with `create_memo`, without asking, when the person accepts a final
  (approves it, says it's done or they'll send it, or copies it to use), untouched
  finals included. A revision just shown is not accepted yet.
- Send the first draft exactly as first shown, or `first_draft_missing`; never rebuild
  it.
- Don't save abandoned drafts, writing not in the person's own voice (for someone else,
  a template), a final holding a secret (say why; never redact), saves the person
  declines, or, with `keep_memos` false, anything they didn't ask to remember. Milton
  has no secrets filter: a public, model-free one is easy to route around and refuses
  real text, so the instructions are the guard.
- Send as `request` what they asked for: their own words when they said it, no pasted
  text, or one short line on what they agreed to when they only agreed to the AI's offer
  or the result. Never send secrets, the person's correction messages or other people's
  text; summarize the situation in `context.summary`.
- When the person asks to remember a preference, apply it now and keep it in the AI's
  own memory or instructions; Milton keeps no standing rules, and their changes to the
  AI's drafts are kept as tweaks.
- After a saved memo, tell the person its receipt word for word, in one line, with no
  question. A failed save is reported.

## The receipt

A saved memo's result carries `memo` (`memo_id`, tier, kind, change and, with a kept
first draft, its changes' state and count) and `receipt`, the line the AI tells the
person: "Kept memo: <kind, or medium without one>.", for example "Kept memo: vendor
decline." The change score stays in the result and on the memo page, not in the line.
