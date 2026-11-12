---
name: memos
description: What a memo, tweak, cover sheet and report are; what a memo holds, its tier and change score; tweaks, kinds, the cover sheet and when AIs save
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

- A **memo** is one piece of writing Milton keeps: the AI's first draft, the final the
  person accepted, and the tweaks between them. Writing the person pastes or asks the AI
  to remember is a memo with only a final. `create_memo` does what its name says.
- A **tweak** is one line naming a habit the person made the AI change, plainly ("no
  warm-up opener"), with a condition only when the habit doesn't hold in all their
  writing ("vendor replies: no price talk").
- A **change** is one spot where code found the first draft and the final differ. The
  memo page lists them under "What changed"; no AI sends, labels or reads them.
- The **cover sheet** is the person's own voice guide, written only by them.
- A **report** is what Milton assembles for one draft: the cover sheet, the
  best-matching finals as **examples**, then the tweaks ([reports](reports.md)). There
  are no fixed reports.
- "Did you get the memo?" means "have you read the writing I've settled on?"
- User-facing copy says "memo", "tweak", "cover sheet", "report" and "AI". Rules,
  samples, instruction cards, the five fixed reports, `list_reports`, exact edits,
  moves, session capture, the sample offer and rule-after-twice are gone, with no
  aliases.

Saves and reads are model-free: the AI writes the tweaks and the context summary, and
Milton stores the bytes it is sent, finds what changed, computes a tier and a change
score with plain code, and counts tweak citations. How a save commits is in
[saves](saves.md).

## What a memo holds

- Two texts word for word: the first draft, exactly as the AI first showed it (in edit
  mode, its first edit of the person's text), and the final the person accepted, hand
  edits included.
- The first draft's state: `kept`, `missing` (the AI sent `first_draft_missing` because
  it no longer had the draft verbatim) or `none` (writing the person gave).
- With `first_draft` or `first_draft_missing`, `mode` (`draft` or `edit`) and `rounds`
  (redrafts after the first draft, 0 to 1000) are required. With neither, the memo is
  final-only (setup, "remember this") and takes no mode, rounds, tweaks or request.
  Both together are refused. Shape problems are refused before any database work.
- With a kept first draft, the list of what changed ([Changes](#changes)) and its state:
  `itemized` or `too_large`; empty for memos saved before 0015.
- The person's typed **request**, when the AI sends one on a drafted memo
  ([The request](#the-request)).
- A context: a one-line placeholder-safe `summary` of the situation and the text
  replied to (never the quoted text, at most 200 characters), `medium`, and optional
  `audience` and `purpose` (at most 100 characters each).
- An optional kind ([Kinds](#kinds)), the change score, the tier, the `report_id` of the
  read before the draft with the tweak ids that report served, the AI (issuer and
  client), the request ID and its times. Recording the served tweaks lets the TPS page
  show what was served without relying on the AI.
- Not asked for: intermediate drafts, the person's correction messages and other
  people's text. The ask is kept only as `request` ([The request](#the-request)).
- A save whose final, first-draft state and first draft match a memo on file returns
  `unchanged` with that memo, adding nothing, so a repeat never counts its tweaks twice.
- `report_id` must be one of the account's served reports (`invalid_report`).
- `memo_context` replaces a memo's medium, summary, audience and purpose (an omitted
  optional field clears) and, when sent, its kind; a memo's words never change. The
  same context returns `unchanged`; an unknown memo is `invalid_memo`.
- With **Keep memos** off, a memo with a first draft (kept or missing) is refused with
  `memos_off`; a final-only memo, writing the person asks to remember, still saves. The
  switch is on by default (no settings row means on).

## Bounds

These are fixed in code and the schema; no memo bound reads `store_config`. Which finals
are served as examples, and their size cap, is in [reports](reports.md#examples).

| What                           | Bound                                             |
| ------------------------------ | ------------------------------------------------- |
| Request body                   | 256 KiB, before parsing ([hosting](hosting.md))   |
| A final or first draft         | 256 KiB UTF-8, non-blank, well formed, no NUL     |
| Cover sheet                    | 1,500 characters; an AI adds lines of at most 300 |
| Summary / tweak                | 200 characters each, one line                     |
| Audience, purpose / kind label | 100 / 60 characters, one line                     |
| Tweaks per memo                | 10 sent, 3 distinct                               |
| A stored change, each side     | 300 characters, cut and marked                    |
| Request                        | 600 characters, 12 lines                          |
| Memos per forget               | 100                                               |

Words are stored exactly as sent; invalid Unicode and NUL are refused before a driver
could replace them.

## Tiers

Milton sets each final's tier at save, from the memo's source alone:

- **your words** (`own`): final-only memos and edit-mode memos;
- **steered by you** (`steered`): drafted memos whose kept first draft differs from the
  final, or, with the first draft missing, that had at least one round;
- **accepted untouched** (`untouched`): drafted memos whose kept first draft equals the
  final, or, with it missing, that had no rounds. Untouched finals are never served; they
  count only on the scoreboard.

## Change score

- Normalized token Levenshtein (words and single punctuation marks) from the first
  draft to the final, over the longer token count, from 0 to 1.
- Only the middle after a shared prefix and suffix is compared. It is computed only for
  a kept first draft, and left empty when that middle exceeds 20 million token pairs.
- A saved memo's result shows the change to three decimals.

## Changes

What changed from a kept first draft to its final is found by code at save, once,
before any database work, and shown only to the person. Nothing is computed for a
missing first draft or writing the person gave. No AI sends, labels or reads changes
in this release: the AI-labelled changes, quote matching and served examples the spec
proposed were left out ([the spec's follow-up](research/memo-evidence-spec-2026-11-11.md)).

- **Code's list.** Both texts are split into words and single punctuation marks, as the
  change score splits them, and case counts ("Hi" against "hi" is a change, since
  lowercase is a habit). A shared prefix and suffix are skipped, then a Myers diff runs
  on the middle. Edits separated by at most two unchanged tokens on one line are one
  **spot**, so `Hi Dana,` → `Dana —` is one. A spot whose sides differ only in Markdown
  marks (``* _ # ` > ~ |``) and whitespace is about `format`.
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
  replayed memos to `too_large`, and with no labels or served examples a marked cut
  hides nothing. `about` is `format` for a Markdown-only spot, code's own marker, and
  NULL otherwise; `by` and `tweak_id` stay NULL ([database](database.md)).
- A saved or unchanged result's `memo` carries `changes: {state, found}`: the state and
  the rows that are not format. A save's stored receipt holds only these, never a side
  ([saves](saves.md#receipts)).
- Changes are never served to an AI and never rank or score anything.

## The request

- `request` is optional and only on a drafted memo (`first_draft` or
  `first_draft_missing`). The AI is asked to send the instruction the person typed to
  start the writing, exactly as typed, with pasted or quoted material and secrets cut and
  each cut marked `[…]`; in edit mode the instruction, never the text to edit; never
  their later corrections. That is guidance, not a guarantee.
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
- From 10, it shows the medians of rounds and change and the share accepted as-is (final
  equal to the first draft) for the latest 5 against the first 5.
- From 60, it compares the last 30 days with the 30 before.
- Rounds are self-reported, so change is the headline figure.

## Kinds

- Kinds belong to the account. A memo names one with `kind_id` or `new_kind`; sending
  both is refused.
- `kind_id` must name one of the account's kinds (`invalid_kind`); a memo's
  `kind_id: null` is read as omitted, before the input is hashed.
- `new_kind` (one line, at most 60 characters) reuses a kind with that label in any
  letter case, else creates one. Labels are unique per account in any letter case.

## Tweaks

- A tweak is one line of at most 200 characters on one account, with the AI and time it
  came from.
- Tweaks come from the AI in the same `create_memo` call, only when the final differs
  from the first draft. The list takes at most 10, as the released definition did, but a
  memo teaches at most three distinct tweaks (distinct ids plus distinct normalized
  wordings); more is refused before any database work as `invalid_input` with field
  `tweaks`, whose next step keeps the three most likely to recur (Peter, 2026-11-11).
  Tweaks on a memo whose final equals its first draft are refused. An empty `tweaks`
  list is read as omitted, before the input is hashed.
- `{tweak_id}` must name one of the account's tweaks (`invalid_tweak`).
- `{text}` is normalized (Unicode NFC, lower case, collapsed spaces, trailing
  punctuation dropped) and reuses the account's tweak with that form, else is added;
  text of only punctuation is refused. A tweak named twice in one memo is cited once.
- Each memo-and-tweak pair is one citation; a tweak's count is its citations.
- A tweak's score counts the account's memos with a kept first draft saved since the
  tweak's text was last set (created, or reworded on the TPS page, recorded in
  `text_changed_at`): **served** is how many of them had it in their served tweaks, and
  **needed again** how many of those also cite it, so it did not work as written. It is
  computed at read, never stored, and never ranks, hides or reorders tweaks.
- Needed again is a lower bound: it counts only when the AI reuses the tweak's id or its
  exact wording. A reworded tweak's counts restart from the new wording; resending the
  same text keeps them.
- The TPS page deletes a tweak with its citations, or rewords it in place, keeping its id
  and citations; a wording another tweak already has is refused with `tweak_exists`.

## The cover sheet

- One free-text document per account, at most 1,500 characters, written only by the
  person. Every change appends a version (from 1) recording the AI (its issuer and
  client) that made it; nothing is overwritten. Versions marked as the person's came
  from the TPS page's former cover sheet form and stay as they are.
- Only an AI connected with Read and write changes it, on the person's words; the TPS
  page shows it read only (Peter, 2026-11-10).
- `cover_sheet` from an AI carries `expected_version` and either `add` (one line, at most
  300 characters) or `remove` (one whole existing line, copied exactly). The AI never
  resends the whole text.
- A stale `expected_version` returns `conflict` with the current version and text.
- Adding a line already present is `unchanged`; removing a line not present is
  `line_not_found`. Removing the last line empties the cover sheet (Peter, 2026-11-10);
  with no memos either, the account is `is_empty` again and setup is offered
  ([setup](setup.md)).
- A change past 1,500 characters is refused with `cover_sheet_limit`.
- Memos are saved only by AIs too: the web app's own session cannot call `create_memo`
  ([saves](saves.md)).
- The cover sheet is `get_cover_sheet`'s text and the first part of every report.

## What the AI is told

The server instructions ([mcp](mcp.md)) carry this guidance. It is AI guidance, not
server enforcement: Milton cannot see the conversation, no hook or plugin is involved,
and whether the receipt line shows depends on the client. Fidelity and capture rate are
measured per client before any claim of reliability.

- Before writing or editing for or as the person, read `get_cover_sheet`, then
  `get_report` with an intent.
- Precedence when guidance disagrees: what the person says now, then the cover sheet,
  then tweaks, then examples. Imitate examples' wording.
- When the person says what to write (read-write connection), their words are the raw
  material: reuse their phrases word for word where they fit, add only a greeting, a
  sign-off and connecting words in the manner of their examples, and don't expand on
  what they said.
- Edit mode: change only what was requested and keep the person's other words, length,
  tone, greeting and sign-off; guidance never widens an edit's scope, and changes are
  briefly listed.
- Asked "Did you get the memo?" or "Did you get that memo?", read `get_cover_sheet`
  even after an earlier read, then `get_report` for the task; confirm only after a
  successful read, and report empty results and failures honestly. Quoting or
  discussing the phrase is not an invocation. A read-only connection treats it as a
  read, never a save.
- Save a memo with `create_memo`, without asking, when the person accepts a final
  (approves it, says it's done or they'll send it, or copies it to use), untouched
  finals included. A revision just shown is not accepted yet.
- Send the first draft exactly as first shown, or `first_draft_missing`; never rebuild
  it.
- Don't save abandoned drafts, writing not in the person's own voice (for someone else,
  a template), saves the person declines, or, with `keep_memos` false, anything they
  didn't ask to remember.
- Tweaks are one line per habit the person made the AI change that is likely to recur,
  at most three, named plainly ("no warm-up opener") with a condition only when it
  doesn't hold everywhere, never "when requested"; most memos teach one or none. Skip
  one-off facts they added and changes made unasked; reuse a served tweak's id for the
  same change. Send as `request` only what they typed to ask, no pasted text. Never send
  secrets, the person's correction messages or other people's text; summarize the
  situation in `context.summary`.
- After a saved memo, tell the person its receipt word for word, in one line, with no
  question. A failed save is reported.
- The cover sheet changes only on the person's words ("remember …", "add to my cover
  sheet"): add their exact line, or remove an exact line on request. Never add tweaks or
  the AI's own inferences, or offer to. A correction during a draft is a tweak, not a
  cover sheet line.

## The receipt

A saved memo's result carries `memo` (`memo_id`, tier, kind, rounds, change, its tweaks
and, with a kept first draft, its changes' state and count) and `receipt`, the line the AI tells the
person:
"Kept memo: <kind, or medium without one>, <n rounds, or "your words">, tweaks: <up to
three, "; "-joined>." with "and N more" past three, for example "Kept memo: vendor
decline, 2 rounds, tweaks: no warm-up opener."
