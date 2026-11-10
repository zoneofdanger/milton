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

What each change does to memos and the cover sheet is in [memos](memos.md), and
forgetting in [deletion](deletion.md). There is no pending state: a save commits whole
or not at all.

## Before the transaction

- The input schema is strict ([mcp](mcp.md)), and a save's shape is checked before any
  database work; those refusals write no receipt.
- Only AIs can call `create_memo`: a save through the web app's store is refused with
  `assistant_required`. The TPS page's own changes go through its store, under the same
  account lock ([TPS page](tps-page.md)).

## The transaction

A save runs in one transaction:

1. Take the account lock. Every writer locks the account row `FOR NO KEY UPDATE`: writers
   serialize with each other and with sign-in, lifecycle and deletion (`FOR UPDATE`), but
   a foreign-key check, such as a usage row's, does not wait on them.
2. Replay a known request ID: the input is hashed (SHA-256 of its JSON), and the same
   request ID with the same input returns the stored outcome. The same request ID with
   different input is refused with `request_id_reused`. A concurrent save of the same
   request waits on the account lock, then replays.
3. Check the trial gate ([billing](billing.md)). Gate refusals write no receipt, so the
   same request can succeed once the gate opens. A replay never reaches the gate.
4. Decide the outcome. A request over 256 KiB is `request_too_large`. Otherwise the
   change runs after a savepoint: a refusal (such as `invalid_kind`, `invalid_tweak`,
   `memos_off` or `cover_sheet_limit`) rolls back to it, so nothing changes. A memo, its
   new kind, its new tweaks and its citations are written together.
5. Write the receipt last, once, with the outcome, refusals and cover sheet conflicts
   included, so the same request ID and input replay that outcome.

## Failures

- A transient or unknown database error (`store_unavailable`: a timeout, deadlock or
  lost connection) rolls back the whole save, receipt included, so the same request can
  succeed on retry. A crashed request commits nothing and leaves no receipt.
- If the commit's acknowledgment is lost, Milton looks up the receipt under the account
  lock: present, it returns the stored outcome; absent, nothing was written and the
  store error stands. Only when that lookup fails too does it return
  `save_outcome_unknown`: repeat the same request.
- To recover an uncertain request, the AI reuses exactly the same arguments; a
  `conflict` is a stale cover sheet version and needs a reread and a new request, never
  a blind retry.

## Receipts

- A receipt (`save_requests`) holds the account, request ID, input hash, outcome and
  time. The outcome can hold a memo's kind and tweaks or the cover sheet's text.
- A receipt is written once and cannot change.
- A save of a known request is not counted as usage again ([billing](billing.md)).
