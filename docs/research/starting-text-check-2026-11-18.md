---
name: starting-text-check-2026-11-18
description: 2026-11-18 offline check, fictional person: the right memo was updated in 36 of 36 edits in Claude Code and in Codex; no other memo overwritten
type: research
---

# Starting text: the two-session check

Run on November 18, 2026, by a temporary builder for milton-78, as the
[spec](starting-text-spec-2026-11-18.md)'s "Check before release" requires, on the
`agent/starting-text` branch at `56bd4b5`. Every person, organization and piece of
writing is fictional, written by an AI: Dana Whitcomb, volunteer coordinator of a
community garden in Dayton, Ohio, with seven saved pieces. Nothing touched production
Milton, a real account or real mail.

**Both bars were met in Claude Code: the right memo was updated in 36 of 36 scenario-A
edits (the bar was 28), and no run overwrote another piece's memo.** Codex, reported and
not gating, also updated the right memo in 36 of 36 and overwrote no other memo, but it
reached 21 of them through `replaces` in edit mode, which relabelled those drafted memos
as "your words", and it skipped one save. Every `started_from` that named stored text
arrived byte-exact (27 in Claude Code, 15 in Codex).

## What was compared

Session one was not run: its seven memos were seeded straight into the store. Session
two was a fresh AI session in an empty folder holding `writing.md`, the person's own
document of the seven finals, and it got scripted user turns that talk only about the
writing, never about memos, ids, `started_from`, `replaces` or duplicates.

| Piece                   | Medium | Saved as                    | Used in |
| ----------------------- | ------ | --------------------------- | ------- |
| P1 workday email        | email  | drafted, steered            | A       |
| P2 donor thank-you      | email  | drafted, steered            | A, C    |
| P3 board note           | chat   | drafted, steered            | A       |
| P4 tool shed reminder   | chat   | drafted, accepted untouched | A       |
| P5 newsletter blurb     | post   | edit mode, "your words"     | B       |
| P6 stock waitlist reply | email  | drafted, steered            | D       |
| P7 mulch decline        | email  | drafted, steered            | E       |

Finals ran from 179 to 286 characters, each with a different first draft but P4's. In
`writing.md` every final is byte-identical to the stored one except P5's, which has one
sentence the person added by hand after it was saved.

- **A**, four edits in one session (P1 to P4): "In the workday email, make the start time
  8:30 instead of 9", then "Good, keep that." Three requests per piece, fixed before
  any run; run _i_ used request _(i−1) mod 3_ and started at piece _(i−1) mod 4_.
- **B**, an edit of P5 (three requests, rotated the same way). Correct: an ordinary save,
  P5's memo left alone, since its stored final is no longer the text being edited.
- **C**, a thank-you to a different couple for a different gift, "the same structure as
  my thank-you to Ruth and Walter", then "Good, I'll send that." Correct: P2 untouched.
- **D**, a reply to a new person asking for a plot; then "Use my usual waitlist reply from
  writing.md, exactly as it is"; then "Good, I'll send that." Correct: P6 untouched.
- **E**, "a fresh draft of it from scratch instead of tweaking the old one" of P7, then
  "Good, I'll send that." Correct: P7 untouched, a second memo kept.

## The instrument

- **Server.** A local MCP server on `127.0.0.1`, built from the branch's own
  `createMiltonServer` and the SDK's `createMcpHandler` in stateless mode as production
  uses it, so the instructions, tool descriptions, schema, flattening and refusals were
  the branch's exactly. One fresh store per run, at its own path.
- **Store.** In memory, for one account. Its save mirrors `compiledMemos.saveMemo` and
  `runSave`: the same removed-field, bidi and schema refusals, the real `checkMemo` (so
  `started_from` with `mode: draft` or beside `replaces` got the real messages), receipts
  and replay, the request-size check, and `saveMemo`'s rule line for line: the one memo
  whose final equals `started_from` byte for byte, the replace path's first-draft check,
  the stored first draft and mode kept on a match, the unchanged and duplicate checks,
  and the real `tier`, `change`, `changeList` and `changeRows`. Its report uses the real
  `rankMemos`, `selectExamples`, `servesChanges`, `changeBlocks` and `quote`, so the
  untouched P4 was never served and at most three steered finals were; the one stand-in
  is the full-text rank, a count of the situation's words found in a memo's summary and
  final instead of Postgres `ts_rank`.
- **Unit check.** Before any run, 14 checks of the store against the spec table's rows it
  implements: a match on a drafted, an untouched and a given memo; a save's own first
  draft set aside; `unchanged` on the same final; the collision row; two holders and no
  holder (the hand-edited text, and a final line break) as ordinary saves; both shape
  refusals; `replaces`; replay. All passed.
- **Log.** Every tool call with its full arguments and result, and the account's memos
  after each `create_memo`, one JSONL file per run. Scoring is plain code over those
  logs: a memo counts as updated when its id survives with a different final, and a new
  memo is assigned to the seeded piece whose words it shares most.
- **Claude Code** 2.1.327, `claude -p` with `--resume` per turn, on the isolated
  `~/.claude-newcomer` profile with `--strict-mcp-config` and an MCP config naming only
  the fake server as `milton`. Every turn's init event listed one MCP server, `milton`,
  connected. Built-in tools were limited to Read, Edit, Write, Glob and Grep, all allowed,
  with the two Milton tools; no turn had a permission denial. Model `claude-opus-5-5` on
  every turn.
- **Codex** 0.170.0, `codex --no-daemon exec --json` and `exec resume` with stdin
  closed, with its own `CODEX_HOME` holding a hand-written `config.toml` that lists only
  the fake server, `approval_mode = "approve"` for `create_memo` as the setup page says,
  and the setup page's standing line in that home's `AGENTS.md`. Workspace-write
  sandbox. It signed in through a link to the existing isolated test profile's sign-in
  file, whose token needed no refresh that day. Model `gpt-6.2-sol`, Codex's default,
  at its default effort. `codex mcp add` was never run, and `~/.codex` was not used:
  its `config.toml`, and the Milton entry in it, hashed the same before and after.

### What the pilot found

One pilot run of each scenario in Claude Code, read by hand, found no instrument fault:
the tools loaded, nothing waited on a permission, and every turn reached acceptance.
The first Codex pilot found one: with no `AGENTS.md`, Codex listed Milton's tools and
never called them (scenario E: no read, no save), as the setup page warns. The standing
line was added to the isolated home's `AGENTS.md`, as setup offers a Codex user, and
four more Codex pilots (E, A, B, C) then read and saved. Claude Code ran on its test
profile as it was, without one. The ten pilot runs are not counted. Nothing else was
changed after the pilots, and nothing at all once the full runs began.

## Results

### Claude Code, 45 runs of 45

| Scenario, 9 runs each            | Right result                   | Second memo | Other memo overwritten | Save missing | Reads |
| -------------------------------- | ------------------------------ | ----------: | ---------------------: | -----------: | ----: |
| A, 36 edits                      | **36 updated the right memo**  |           0 |                      0 |            0 |    23 |
| B, hand-edited since saved       | 9 ordinary saves, P5 untouched |           9 |                      0 |            0 |     9 |
| C, new piece from a template     | 9 new memos, P2 untouched      |           — |                      0 |            0 |     9 |
| D, text identical to a saved one | 9 new memos, P6 untouched      |           — |                      0 |            0 |     9 |
| E, whole rewrite as a draft      | 9 new memos, P7 untouched      |           9 |                      0 |            0 |     9 |

- **How A's 36 updates arrived:** 27 by `started_from`, all 27 byte-exact and in edit
  mode, and 9 by `replaces` with an id the report had served (three whole runs chose
  `replaces` for every served piece). The untouched P4, never in a report, was updated
  by `started_from` in 9 of 9. One run made no `get_report` call at all and still updated
  all four by `started_from`.
- **Labels kept:** every updated memo stayed drafted. The 27 steered ones stayed
  steered and the 9 untouched P4s became steered; none became "your words".
- **B:** 9 of 9 sent `started_from` holding the file's hand-edited text, which no memo
  held, so each was an ordinary edit-mode save, as the spec intends. P5's id was in the
  report every time and `replaces` was never sent.
- **C, D, E:** no save carried `started_from` or `replaces`; each was a draft-mode save
  with its first draft. In D, all 9 accepted finals were byte-identical to P6's and
  became their own memo beside it, since their first drafts differed. In E no AI sent
  `started_from`, so no refusal arose and nothing was relabelled.
- **Not byte-exact:** 9 `started_from` values, all of them B's hand-edited text, the
  case built to miss. None differed by whitespace, line endings or quotes.
- **Usage:** $17.64 on full runs and $2.30 on pilots, as `claude -p` reports cost on a
  subscription.

### Codex, 45 runs of 45

| Scenario, 9 runs each            | Right result                             | Second memo | Other memo overwritten | Save missing | Reads |
| -------------------------------- | ---------------------------------------- | ----------: | ---------------------: | -----------: | ----: |
| A, 36 edits                      | **36 updated the right memo**            |           0 |                      0 |            0 |    48 |
| B, hand-edited since saved       | 6 ordinary saves; 3 updated P5 by its id |           6 |                      0 |            0 |    11 |
| C, new piece from a template     | 9 new memos, P2 untouched                |           — |                      0 |            0 |     9 |
| D, text identical to a saved one | 8 new memos, P6 untouched                |           — |                      0 |            1 |    15 |
| E, whole rewrite as a draft      | 9 new memos, P7 untouched                |           9 |                      0 |            0 |    11 |

- **How A's 36 updates arrived:** 15 by `started_from`, all byte-exact and in edit mode
  (all 9 of the untouched P4, never in a report, and 6 others), and 21 by `replaces`
  with a served id. Codex sent 43 saves for the 36 edits: 7 were refused and resent
  (5 `replace_first_draft` for sending its own edit as the first draft of a drafted memo,
  1 `invalid_kind`, 1 `first_draft_missing` without a mode), each then saved.
- **Labels changed by `replaces`:** all 21 of those replaces sent `mode: edit` with
  `first_draft_missing`, so each of those 21 drafted, steered memos became edit mode,
  "your words". This is the `replaces` behaviour the spec noted and left for a separate
  decision; it is not the new field's. The 15 matched by `started_from` kept their mode
  (the 9 untouched P4s became steered, the 6 others stayed steered).
- **B:** 6 sent `started_from` holding the hand-edited text and made an ordinary save,
  one of them as writing the person gave (no first draft). The other 3 sent `replaces`
  with P5's served id (after one `replace_first_draft` refusal each, and one malformed
  resend), so P5 itself took the revision. That is its own piece updated by id, not the
  ordinary save the spec named as correct, and not another memo overwritten.
- **C, D, E:** no save carried `started_from` or `replaces`. In D run 6, Codex showed the
  waitlist reply word for word, the person said "Good, I'll send that", and it answered
  "Sounds good." without saving; the other 8 saved it as a new memo beside P6. E saved 9
  of 9 as drafts; no refusal arose.
- **Not byte-exact:** 6 `started_from` values, all B's hand-edited text. None differed by
  whitespace, line endings or quotes.
- **Usage:** Codex reports tokens, not cost: 36.5 million input (32.6 million cached),
  164,352 output and 2,547 reasoning across the 45 full runs.

## The bars

Set by the spec before the run, and unchanged:

- **Any other memo overwritten fails the run.** Claude Code: none in 45 runs; met.
  Codex: none in 45 runs.
- **The right memo is updated in at least 28 of 36 scenario-A edits in Claude Code:**
  36 of 36; met. Codex, which does not gate: 36 of 36.

A rewrite saved over its own piece's memo (E) or a hand-edited piece's memo updated by
id (B) would have been reported beside, not counted as, another memo overwritten.
Neither happened in Claude Code; in Codex, 3 B runs updated P5 by id.

## Transcripts

**A hit, the untouched piece (Claude Code, A run 1, the fourth edit).** P4 had never
been in a report, so the AI had no id for it.

> **Person:** Next one. In the tool shed reminder, make the date December 3 instead of
> December 1.
>
> **AI:** I changed the date in the tool shed reminder from December 1 to December 3.
> That was the only edit: […]
>
> **Person:** Good, keep that.
>
> **AI:** Great. The tool shed reminder now says the combination changes on December 3.

Its save sent `mode: edit`, its own edit as `first_draft`, and `started_from` with P4's
stored final byte for byte. The result was `saved`, `replaced: true`, P4's id, tier
steered, change 0.02, one change found, no receipt, and the AI said nothing about it.

**The designed miss (Claude Code, B run 2).**

> **Person:** In the plot renewal blurb for the newsletter, make the renewal deadline
> January 24 instead of January 31.
>
> **AI:** I changed the renewal deadline […] It now reads: […] To keep your plot, renew by
> January 24. You can renew online or at the January potluck. […]
>
> **Person:** Good, keep that.
>
> **AI:** Kept memo: newsletter blurb.

`started_from` held the blurb with the person's added sentence, which no memo held, so
the save was a new memo and P5's stored version stayed beside it: the limit the spec
accepts.

**The same case answered by id (Codex, B run 3).**

> **Person:** In the plot renewal blurb for the newsletter, change "just ask me" to "just
> email me".
>
> **AI:** Changed "just ask me" to "just email me" in the plot renewal newsletter blurb.
>
> **Person:** Good, keep that.
>
> **AI:** Done.

Its first save sent `replaces` with P5's id and its own edit as `first_draft`, and was
refused with `replace_first_draft`; it resent with `first_draft_missing` and P5's
stored version was replaced by the hand-edited, revised text. No `started_from` was
sent.

## Limits

- One fictional person, seven short pieces, scripted turns that always accept; one model
  per client at its default settings. Real sessions wander, revise twice and paste.
- The pieces were short and plain: one em dash, but no curly quotes, CRLF or trailing
  spaces in any final, and every final in the file was byte-identical to the stored one
  but P5. The check measured transit, not the person's own reformatting.
- Each A run's own edits changed the file, but no run edited a piece twice, and no two
  sessions edited one piece.
- The report's full-text rank is a stand-in, so which pieces were served, and therefore
  how often an id was available for `replaces`, may differ from production.
- Claude Code ran without the standing line and Codex with it, so the comparison
  between clients is not like for like.
- Scenario E never exercised the draft-mode refusal in either client, since no AI sent
  the field on a draft; how an AI reacts to that refusal is untested.
- The fake server is not the database: the collision, forget, two-session and replay
  rows are left to the branch's integration tests, as the spec says.

## Not run

- A first session that saves the pieces itself.
- Other clients (ChatGPT, Claude.ai), other models and other effort settings.
- A placebo arm without the field: how often an AI would have used `replaces` alone, or
  saved twice, without `started_from` was not measured here.
