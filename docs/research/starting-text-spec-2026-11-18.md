---
name: starting-text-spec-2026-11-18
description: The spec Peter approved on 2026-11-18 for started_from: an edit names its starting text, and the one memo holding it is updated; frozen
type: research
---

> Historical and frozen. This is the spec as approved by Peter on 2026-11-18, before any
> of it was built. Where it differs from the concept files in `docs/`, those describe
> Milton as it is now ([saves](../saves.md#starting-text), [memos](../memos.md),
> [mcp](../mcp.md)). As built, the too-large next step is one step for every
> `request_too_large`, so it says to send without `started_from` in general terms: the
> HTTP refusal of an oversized body comes before the body is read.

# Spec: an edit names the text it started from (approved by Peter, 2026-11-18)

Written by milton-78 on 2026-11-18 and revised once after milton-astra's review of the
rule, the same day, before any code. Peter approved it as written on 2026-11-18.

## Problem

On 2026-11-18 a second AI session revised four pieces another session had saved on
Peter's account. It sent `replaces` for the one whose memo id its report had shown, and
saved the other three as new memos (1 of 1 and 3 of 3). Each of those three then existed
twice. The copies were saved in edit mode, so they were labelled "your words" and ranked
first in later reports, beside the versions they superseded.

The gap is finding the id, not willingness to replace: an AI can send `replaces` only for
an id it has seen, and a report shows a few. The second session did hold each original's
stored final word for word before it edited (3 of 3, checked in its transcript).

## Change

1. **A new optional field, `memo.started_from`:** the piece exactly as it stood before
   this edit. It is allowed on an edit-mode save and on writing the person gave (no first
   draft). A draft the AI wrote (mode `draft`) is always its own memo: with
   `started_from` it is refused before any database work, and told to send again without
   the field.
2. **The match.** In the save's transaction, under the account lock, the save updates a
   memo only when exactly one of the account's memos has a final equal to `started_from`
   byte for byte. Nothing is trimmed, normalized or compared by similarity.
3. **On a match, only the words change.** The matched memo keeps its id, creation time,
   first draft, first-draft state and mode. The save's final, context, kind and request
   replace the memo's. The save's own `first_draft`, `first_draft_missing` and `mode`
   are set aside, with any changes worked out from them. Milton works out the changes,
   change score and tier from the stored first draft and the new final, as a `replaces`
   with `first_draft_missing` does today. A request is kept only on a drafted memo, as
   now.
4. **No match** (no memo, or more than one, holds that text): an ordinary save, exactly
   as if `started_from` had not been sent.
5. **No separate copy is kept.** `started_from` is part of the hashed input, like every
   field, and is stored nowhere of its own. The same words stay on file only where the
   save also sent them as its final or first draft.
6. **Outcome of a match:** `saved` with the matched memo's id, `replaced: true` and no
   receipt line, as for `replaces`; or `unchanged` when the new final is the one the memo
   already holds, in which case its context and kind are not touched either.

Why exact matching: three duplicate pairs from one account cannot set a similarity
cutoff (their shared word pairs were 0.92, 0.64 and 0.31, against 0.22 for the closest
unrelated pair), and a wrong match here deletes a memo's words. An exact match needs no
cutoff and serves nothing new to AIs, and a starting text that is no longer current
simply fails to match.

Why edits only: with the origin kept, a matched draft-mode save would label an AI's
from-scratch rewrite of the person's own text as "your words". Leaving drafts out closes
that, at the cost that a from-scratch redraft in a second session leaves the older
version on file beside it.

## The rule and its cases

**Invariant.** A save carrying `started_from` changes an existing memo only when it is
an edit or writing the person gave, and exactly one of the account's memos holds a final
byte-identical to `started_from` at the moment of the save. It then changes that memo's
final, context, kind and request and nothing else about it. In every other accepted case
the save behaves as if `started_from` were absent.

| Case                                                                           | Result                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| One memo holds that final; it was drafted and keeps its first draft            | Updated. First draft, state and mode stay. Tier is steered, or untouched if the new final equals the first draft                    |
| One memo holds it; accepted untouched until now                                | Updated; becomes steered when the new final differs from its first draft                                                            |
| One memo holds it; its first draft is missing                                  | Updated; stays "missing" with its stored mode; no changes listed                                                                    |
| One memo holds it; writing the person gave (no first draft)                    | Updated; stays final-only and "your words"; a sent request is not kept                                                              |
| The edit-mode save sent its own first draft                                    | That draft, its mode and the changes worked out from it are set aside, so a drafted memo never becomes "your words" by being edited |
| The new final equals the matched memo's final                                  | `unchanged`, that memo; its context and kind are not updated                                                                        |
| After the update another memo would hold the same final, state and first draft | As a replace today: the matched memo goes and the other is returned `unchanged`, as it is, whatever its mode and context            |
| Two or more memos hold that final                                              | Ordinary save; nothing is replaced                                                                                                  |
| No memo holds it (new writing, or the text changed since it was saved)         | Ordinary save                                                                                                                       |
| Two sessions start from the same final and save different revisions            | The first updates the memo; the second no longer matches and is an ordinary save, so two memos result                               |
| The matched memo was forgotten first                                           | Ordinary save: the revision is kept as a new memo. Milton can't tell the text was ever on file                                      |
| A draft-mode save sends `started_from`                                         | Refused before any database work: send it again without the field                                                                   |
| `started_from` sent with `replaces`                                            | Refused before any database work: send one                                                                                          |
| `started_from` blank, malformed, holding NUL, or over 256 KiB                  | Refused before any database work, as a final is                                                                                     |
| The request is over 256 KiB with the field                                     | Refused as too large today; its next step says to send again without `started_from`                                                 |
| Keep memos is off                                                              | A match is allowed: it stores no new first draft. A drafted save that doesn't match is refused, as today                            |
| The same request id and input again                                            | The stored outcome replays; nothing changes                                                                                         |

## What the AI is told

- The field's description: "Only when you edited writing that already existed (the
  person's earlier version, or a final from another conversation) and you have no
  memo_id for it: that text exactly as it stood before your edit. Milton then updates
  the memo holding it instead of keeping two. Omit it for a draft you wrote, for new
  writing, and for a new piece built from an old one as a template. Omit it too when
  that text holds a secret or other people's words; never alter it to make it fit."
- One clause in `create_memo`'s description. After the copy PR (#156) that description
  serves 1,728 of its 1,800 budget and both descriptions 2,593 of 2,600, so this raises
  the total budget, and the tool's if needed, on purpose (no description may pass
  1,900).
- The server instructions (3,887 of a 3,900 budget) do not change in the first version.
  The check below decides whether they need a sentence.

## Check before release

A fictional two-session run against a fake Milton server that implements the field, with
a fictional person, in Claude Code and Codex, 9 runs a cell as for #139. It uses Peter's
Claude and Codex subscriptions, which this spec's approval covers.

- Session one saves the pieces. Session two starts fresh with the finals in a file.
- Scored separately, each per client:
  - four edits of saved pieces, one of them accepted untouched (36 edits a client);
  - an edit of a piece hand-edited since it was saved, where an ordinary save is the
    right result;
  - a new piece built from an old one as a template;
  - a new piece whose text is identical to a different saved piece;
  - a whole rewrite of a saved piece, written as a draft.
- For each: did it update the right memo, save a second memo, or overwrite another memo,
  and did `started_from` arrive byte-exact.
- Bars, set before the run: any other memo overwritten fails the run, whatever the
  totals; and the right memo is updated in at least 28 of 36 edits in Claude Code. Codex
  is reported and does not gate. Below the second bar, an instruction sentence is tried
  before anything ships.
- The store's own schedules are not left to a cooperative client: the collision, forget,
  two-session and replay rows of the table are database tests.

## Build

- `server/src/mcp-tools.ts`: the field, its description, and the two shape refusals.
- `server/src/store/save.ts`: the lookup under the lock and the update, reusing the
  replace path's delete and insert.
- Tests: the shape refusals; on a disposable Postgres as the MCP role, one test per row
  of the table, two connections where the row is a schedule; a matched save whose
  acknowledgment is lost replays from its receipt; a final line break, CRLF against LF
  and differently encoded Unicode equivalents do not match.
- Docs: saves.md, memos.md, mcp.md. No schema change and no migration.
- Independent review (Codex, GPT-6 Astra): required, since the path deletes and
  reinserts a memo.

## Release and after

- MCP and app images by the release procedure; no migration.
- Rollback is the previous revisions. An AI still holding the new tool definition then
  gets a schema refusal for the unknown field. If it strips the field and saves under a
  new id, the result is an ordinary save, and a matched save that had already committed
  can gain a copy. Recovery is to forget the copy; the release notes say so.
- A week after release, on Peter's account: rerun the pair scan for near-identical
  finals, and count the saves that carried `started_from` in local transcripts with
  their outcomes.

## Limits accepted

- **Text identifies words, not a piece.** If the only memo holding a text belongs to a
  different piece (the piece being edited was never saved, or was forgotten or changed
  meanwhile), that memo takes the revision. Nothing but its id can tell two pieces with
  identical finals apart. It is rare for long text and likelier for a short stock reply.
  On Peter's account today no two of 32 finals are identical and the shortest is 126
  characters.
- A piece hand-edited between sessions no longer matches, so a second memo can still
  appear. So can one when two sessions revise the same final, and when a second session
  redrafts a piece from scratch.
- Byte-exact means a starting text whose whitespace changed in transit does not match.
  The check measures how often.
- An AI that sends the field for a new piece built on a template would overwrite the
  template's memo. The description says not to, and the check must show none.
- A revision of a forgotten memo is saved as a new one.
- It does nothing for duplicates already on file.
- Not built: similarity matching, and listing more memo ids in reports (a summary line
  can describe several pieces, a wrong pick overwrites another memo, and it would serve
  the summaries of untouched memos).
- Not changed: `replaces` by id. Observed while reading it: a `replaces` with
  `first_draft_missing` takes the save's mode, so an edit-mode replace of a drafted memo
  would label it "your words", where the same edit sent with `started_from` would not.
  Left for a separate decision.
