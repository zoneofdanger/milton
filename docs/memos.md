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
---

# Memos

## Vocabulary

- A **memo** is one piece of writing Milton keeps: the AI's first draft, the final the
  person accepted, and the tweaks between them. Writing the person pastes or asks the AI
  to remember is a memo with only a final. `create_memo` does what its name says.
- A **tweak** is one line about what the person made the AI change, with its condition
  where known ("vendor replies: no warm-up opener").
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
Milton stores the bytes it is sent, computes a tier and a change score with plain code,
and counts tweak citations. How a save commits is in [saves](saves.md).

## What a memo holds

- Two texts word for word: the first draft, exactly as the AI first showed it (in edit
  mode, its first edit of the person's text), and the final the person accepted, hand
  edits included.
- The first draft's state: `kept`, `missing` (the AI sent `first_draft_missing` because
  it no longer had the draft verbatim) or `none` (writing the person gave).
- With `first_draft` or `first_draft_missing`, `mode` (`draft` or `edit`) and `rounds`
  (redrafts after the first draft, 0 to 1000) are required. With neither, the memo is
  final-only (setup, "remember this") and takes no mode, rounds or tweaks. Both
  together are refused. Shape problems are refused before any database work.
- A context: a one-line placeholder-safe `summary` of the situation and the text
  replied to (never the quoted text, at most 200 characters), `medium`, and optional
  `audience` and `purpose` (at most 100 characters each).
- An optional kind ([Kinds](#kinds)), the change score, the tier, the `report_id` of the
  read before the draft with the tweak ids that report served, the AI (issuer and
  client), the request ID and its times. Recording the served tweaks lets the TPS page
  show what was served without relying on the AI.
- Not kept: intermediate drafts, the person's correction messages, the ask, and other
  people's text.
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

| What                               | Bound                                             |
| ---------------------------------- | ------------------------------------------------- |
| Request body                       | 256 KiB, before parsing ([hosting](hosting.md))   |
| A final or first draft             | 256 KiB UTF-8, non-blank, well formed, no NUL     |
| Cover sheet                        | 1,500 characters; an AI adds lines of at most 300 |
| Summary / tweak                    | 200 characters each, one line                     |
| Audience, purpose / kind label     | 100 / 60 characters, one line                     |
| Tweaks per memo / memos per forget | 10 / 100                                          |

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
  from the first draft: at most 10 per memo. Tweaks on a memo whose final equals its
  first draft are refused. An empty `tweaks` list is read as omitted, before the input is
  hashed.
- `{tweak_id}` must name one of the account's tweaks (`invalid_tweak`).
- `{text}` is normalized (Unicode NFC, lower case, collapsed spaces, trailing
  punctuation dropped) and reuses the account's tweak with that form, else is added;
  text of only punctuation is refused. A tweak named twice in one memo is cited once.
- Each memo-and-tweak pair is one citation; a tweak's count is its citations.
- The TPS page deletes a tweak with its citations, or rewords it in place, keeping its id
  and citations; a wording another tweak already has is refused with `tweak_exists`.

## The cover sheet

- One free-text document per account, at most 1,500 characters, written only by the
  person. Every change appends a version (from 1) recording whether an AI (its issuer
  and client) or the person made it; nothing is overwritten.
- `cover_sheet` from an AI carries `expected_version` and either `add` (one line, at most
  300 characters) or `remove` (one whole existing line, copied exactly). The AI never
  resends the whole text.
- A stale `expected_version` returns `conflict` with the current version and text.
- Adding a line already present is `unchanged`; removing a line not present is
  `line_not_found`; a removal that would leave it blank is `cover_sheet_empty`, so an AI
  can't empty it.
- A change past 1,500 characters is refused with `cover_sheet_limit`.
- The TPS page's form sends the whole text with the version it showed: line endings
  become `\n`, trailing whitespace is trimmed, the same fence applies, it may empty the
  cover sheet, and the same text is `unchanged`. Memos themselves are saved only by AIs:
  the web app's own session cannot call `create_memo` ([saves](saves.md)).
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
- Tweaks are one line per habit the person made the AI change, with when it applies,
  never "when requested"; skip one-off facts they added and changes made unasked; reuse
  a served tweak's id for the same change. Never send secrets, the person's correction
  messages or other people's text; summarize the situation in `context.summary`.
- After a saved memo, tell the person its receipt word for word, in one line, with no
  question. A failed save is reported.
- The cover sheet changes only on the person's words ("remember …", "add to my cover
  sheet"): add their exact line, or remove an exact line on request. Never add tweaks or
  the AI's own inferences, or offer to. A correction during a draft is a tweak, not a
  cover sheet line.

## The receipt

A saved memo's result carries `memo` (`memo_id`, tier, kind, rounds, change and its
tweaks) and `receipt`, the line the AI tells the person:
"Kept memo: <kind, or medium without one>, <n rounds, or "your words">, tweaks: <up to
three, "; "-joined>." with "and N more" past three, for example "Kept memo: vendor
decline, 2 rounds, tweaks: no warm-up opener."
