---
name: saves
description: How a create_memo save commits: the account lock, receipts, replay and request hashing, refusals, savepoints and the request size
type: behaviour
covers:
  - server/src/store/save.ts
  - server/src/store/compiled.ts
  - server/src/store/accounts.ts
  - server/src/mcp-tools.ts
  - server/src/http.ts
  - server/src/store/database.ts
  - server/src/store/trials.ts
  - server/drizzle/0000_baseline.sql
---

# Saves

What each change does to memos is in [memos](memos.md), and
forgetting in [deletion](deletion.md). There is no pending state: a save commits whole
or not at all.

## Before the transaction

- The input schema is strict ([mcp](mcp.md)), and a save's shape is checked before any
  database work, except the rollout-boundary refusals' receipt lookup (below); those
  refusals write no receipt. That check covers everything the input
  alone shows: the memo's shape, its request's bounds and the mail-like lines it refuses
  ([memos](memos.md#the-request)). With a kept first draft it also computes code's list
  of what changed, within its bounds ([memos](memos.md#changes)); that list is the one
  the save stores, and no client sends a change, label or link.
- Only AIs can call `create_memo`: a save through the web app's store is refused with
  `assistant_required`. The TPS page's own changes go through its store, under the same
  account lock ([TPS page](tps-page.md)).

## Request ids

- 1 to 64 characters of `A-Z`, `a-z`, `0-9`, `.`, `_`, `:` and `-`, matched by the same
  pattern as the database's checks (`^[A-Za-z0-9._:-]{1,64}$`, no flag): a UUID passes;
  a space, `/`, a non-ASCII character or a trailing line break is refused by the schema.
- Compared byte for byte, so case matters, and unique per account across all its AIs:
  the receipt key is `(user_id, request_id)` and every lookup is tenant-qualified. A
  predictable id risks a collision within one account, never access to another.
- Different ids are independent receipts; content dedupe still applies, so the same
  words under `Abc` then `abc` give two receipts and one memo, the second `unchanged`.
- `create_memo` asks the AI for a new random id for each save, such as a UUID, with no
  names, ticket numbers or words from the writing, as Stripe's
  [idempotency guidance](https://docs.stripe.com/api/idempotent_requests) advises for
  its keys: the id stays in the receipt, which outlives forgetting
  ([receipts](#receipts)). The tool description asks only for that; the format above
  is stated in the `request_id` field's description and enforced by the schema
  pattern, unchanged, so older ids still replay.

## Rollout boundary

A request carrying a field `create_memo` no longer takes ([mcp](mcp.md#retired-calls)),
or a one-line field holding a newly refused bidirectional control
([memos](memos.md#bounds)), is refused and never replayed, retries of earlier saves
included. Accepted (2026-11-12) with no compatibility path, like the one-line rule's
limit below. Its words follow one lookup:

- **Order.** Authentication, the connection's scope and the active account come first:
  the handler checks the token or key before the MCP server is built, so a read-only
  connection gets `insufficient_scope` (403) and never reaches the lookup. Then, at
  dispatch, the lookup takes the account lock a save takes (`FOR NO KEY UPDATE`, which
  also refuses a closing account with `account_unavailable`) and asks only whether
  `save_requests` holds a row under `(user_id, request_id)`, this account's. It passes
  no trial gate, as a replay doesn't, admits no call and records no usage. An id the
  database's checks refuse cannot hold a receipt, so it needs no lookup.
- **No receipt.** No save under this id has finished: "No save under this request_id
  has finished. Send it again without those fields (or characters), with the same
  request_id." Its next step is `fix_input`, with no question for the person (#121, a
  stale Claude Code client stopped to ask about a memo never at risk). The resend keeps
  the id, so an earlier attempt that commits after the lookup meets it as
  `request_id_reused` rather than a second memo (milton-overlord, 2026-11-12).
- **A receipt, or a failed lookup.** The earlier attempt may have committed, the retry
  across the release this boundary exists for: "Milton can't recover an earlier outcome
  for this request. Before saving again with a new request_id, ask the person to check
  their TPS page and, if it isn't there, the full TPS.md export (the page lists the
  latest 200 memos), for this memo." Its next step is `ask_user`. Absence from the
  page's list doesn't prove the earlier save failed. The receipt's stored hash is of the
  old shape, so it is never this call's outcome, and nothing of it is returned.
- **The race.** The lock waits for a save of this id already holding it, so its receipt
  is seen; the integration suite runs that schedule on two connections. An attempt
  under the same id that has not yet taken the lock when the lookup runs (a pre-release
  attempt still on its way to an old MCP during the switch) can commit after the "no
  save has finished" answer. The resend under the same id then meets its receipt as
  `request_id_reused` and saves nothing.

## The transaction

A save runs in one transaction:

1. Take the account lock. Every writer locks the account row `FOR NO KEY UPDATE`: writers
   serialize with each other and with sign-in, lifecycle and deletion (`FOR UPDATE`), but
   a foreign-key check, such as a usage row's, does not wait on them.
2. Replay a known request ID: the input is hashed (SHA-256 of its JSON), and the same
   request ID with the same input returns the stored outcome, labelled as a replay
   ([receipts](#receipts)). The same request ID with
   different input is refused with `request_id_reused`. A concurrent save of the same
   request waits on the account lock, then replays.
3. Check the trial gate ([billing](billing.md)). Gate refusals write no receipt, so the
   same request can succeed once the gate opens. A replay never reaches the gate.
4. Decide the outcome. A request over 256 KiB is `request_too_large`. Otherwise the
   change runs after a savepoint: a refusal (such as `invalid_kind`, `invalid_memo` or
   `memos_off`) rolls back to it, so nothing changes. A memo, its new kind and its
   changes are written together; no save writes a cover sheet, a note from edits, a
   citation or a served-report record.
5. Write the receipt last, once, with the outcome, refusals included, so the same
   request ID and input replay that outcome.

## Replacing a final

`memo.replaces` names a memo whose final the person changed after their AI saved it
(Peter, 2026-11-17). The save is a complete memo save, checked, diffed and hashed as any
other, with `replaces` in the hashed input.

- **Allowed** for any of the account's memos, whichever of its AI connections saved it,
  with or without a stored first draft (Peter, 2026-11-17, so that no stale copy
  outlives the person's newer version). An earlier same-connection rule was dropped: an
  AI whose save returned another AI's memo as `unchanged` holds that id, and refusing
  its replace led it to save the person's next edit as a new memo, leaving two finals
  (third and fourth reviews of #148). Each condition is checked in the transaction,
  under the account lock.
- **A memo with a kept first draft** keeps it: the save sends `first_draft` byte for byte
  equal to it, or `first_draft_missing: true` (an AI whose context was compacted still
  has the memo id but not the draft). With `first_draft_missing`, Milton keeps the
  stored first draft and its state, and works out the changes, tier and change score from
  it and the new final, as if it had been sent; the input is still hashed and replayed as
  sent.
- **A memo without one** (first draft `missing`, or writing the person gave) takes the
  save exactly as sent: its own `first_draft`, `first_draft_missing` or final-only shape,
  mode and request. A `first_draft` sent where none was kept is stored as sent, with its
  changes: it is the AI's best copy, and Milton has nothing to check it against.
- **Refusals** save nothing, are stored in the receipt and replay like other refusals,
  checked in this order. `replace_unknown` (no such memo: never saved, or forgotten)
  tells the AI not to save the words again as a new memo, since the person may have
  forgotten it. `replace_first_draft` (a memo with a kept first draft, and a
  save that sends a different `first_draft`, or neither field, which would contradict or
  drop the stored draft and its tweaks) tells it to resend with the same `first_draft`
  or `first_draft_missing`. Each `next` is in `mcp-outcomes.ts`.
- **Applied** inside the savepoint: the old memo is deleted through `deleteMemos`, as a
  forget deletes it (its changes and citations by cascade, legacy notes left with no
  citation after it), then the new memo is inserted under the same id and the old
  `created_at`, with its own change rows, as a normal save inserts them. No memo's words
  or change rows are updated: the MCP role can't (`016-memo-evidence-roles.sql`), and
  reports rely on it ([reports](reports.md#what-they-changed)). It needs no grant beyond
  a save's and a forget's; the integration suite runs it as the MCP role.
- **Duplicates.** When the memo already holds these words (final, first-draft state
  and first draft, after a stored draft stands in for `first_draft_missing`), the
  result is `unchanged`. When another memo holds them, whichever AI saved it, the
  replaced memo is deleted and that one is returned `unchanged`; the AI can replace it
  later by that id. The duplicate check never matches the replaced memo itself.
  Ordinary saves dedupe as before.
- **Keep memos** turned off since the original save does not stop a replace, unless the
  replace would store a first-draft state its memo didn't hold (a first draft or
  `first_draft_missing` on writing the person gave, or a first draft on a memo whose
  draft was missing), which is refused with `memos_off` as any drafted save is. A
  `new_kind` is created only when a memo is written, as on any save.
- **Outcome**: `saved`, with the memo summary under the same `memo_id`, `replaced: true`
  and no `receipt`, so the AI says nothing. Retrying the original save's request id
  still replays its own stored outcome.
- **A forget racing a replace** is serialized by the account lock; a replace that runs
  second meets `replace_unknown`. The integration suite runs that schedule on two
  connections.

## Failures

- A transient or unknown database error (`store_unavailable`: a timeout, deadlock or
  lost connection) rolls back the whole save, receipt included, so the same request can
  succeed on retry. A crashed request commits nothing and leaves no receipt.
- If the commit's acknowledgment is lost, Milton looks up the receipt under the account
  lock: present, it returns the stored outcome; absent, nothing was written and the
  store error stands. Only when that lookup fails too does it return
  `save_outcome_unknown`: repeat the same request.
- To recover an uncertain request, the AI reuses exactly the same arguments.

## Receipts

- A receipt (`save_requests`) holds the account, request ID, input hash, outcome and
  time. A fresh outcome holds a memo's id, tier, kind, change score and its changes'
  state and count, and the receipt line (or a replace's `replaced`); never `rounds` or
  tweaks, a request or a change's text, since receipts outlive forgetting and replacing.
- Historical receipts are never erased or rewritten. A replay returns the stored
  outcome verbatim, old fields included (a memo's `rounds` and AI-written tweaks, a
  `cover_sheet`), and adds one top-level field beside it, `replayed`: "A stored outcome
  from an earlier save. Fields Milton no longer uses, such as rounds and tweaks, are not
  current guidance, and this receipt doesn't prove the memo is still on file." The
  outcome decoder keeps accepting the old fields. Every receipt read back is labelled,
  including one found after a failure (a lost acknowledgment, or a transient failure
  before the lookup), since that lookup can't tell this request's commit from an
  earlier save's.
- The hashed input includes `request`. One-line fields are hashed after the one-line
  rule ([memos](memos.md#bounds)), so a retry that spells a line separator as a space
  replays.
- A rollout limit of that rule, accepted (2026-11-12) with no compatibility path: a
  receipt written before it hashed the raw one-line fields. So a save whose one-line
  field held U+2028 or U+2029, made before the deploy and retried identically after it
  to recover an uncertain outcome, is refused with `request_id_reused`. Only that
  straddling retry is affected.
- The remaining gap of the rollout boundary, accepted (milton-overlord, 2026-11-12):
  after that `request_id_reused`, an AI that follows its step and saves with a new
  request_id can keep the memo twice when the delayed attempt's words differ (the
  content check returns the memo on file as `unchanged` only when they match, and only
  while it is still on file). That needs the narrow race above; `request_id_reused`'s
  step is unchanged.
- Rollback limits, accepted (milton-overlord, 2026-11-12) as a degraded emergency
  fallback: after a rollback to the code before this release, non-UUID ids fail its
  schema and drafted requests without `rounds` fail its preflight before lookup; for
  inputs that pass and match, outcomes holding `memo` without `memo.tweaks` (final-only
  saves, context corrections) fail decoding as `save_outcome_unknown`, while forgets
  and memo-less refusals replay. Clients still holding the new contract may fail fresh
  saves until they refresh. `server/scripts/check-compatibility.ts` reproduces each
  case; the scoreboard's limit is in [TPS page](tps-page.md#scoreboard), and rollback
  order in [releases](deploy/releases.md).
- A receipt is written once and cannot change.
- A save of a known request is not counted as usage again ([billing](billing.md)).
