---
name: deletion
description: What the person controls and how long Milton keeps it: forgetting, Delete all memos, disconnecting an AI, account deletion and the deletion inventory
type: behaviour
covers:
  - server/src/auth-lifecycle.ts
  - docs/deletion-inventory.txt
  - server/src/store/save.ts
  - server/src/store/tps.ts
  - server/src/mcp-tools.ts
  - server/src/auth-account.tsx
  - server/src/billing.tsx
  - server/src/store/billing.ts
  - server/src/store/schema.ts
  - apps/auth/src/**
  - apps/auth/migrations/008-deletion-links.up.sql
  - apps/auth/scripts/prune-usage.ts
  - server/test/deletion-inventory.test.ts
  - apps/auth/migrations/003-mechanism.up.sql
---

# Deletion

## Retention

- Memos are kept until forgotten, deleted with "Delete all memos", or removed with the
  account. There is no timer.
- The cover sheet keeps every version until the account is deleted
  ([memos](memos.md)).
- Usage rows are pruned on the schedule in [billing](billing.md#usage).

## Forgetting and Delete all

- Forgetting a memo (on the TPS page, or `forget_memos` from the AI) deletes it, its
  citations, its stored changes, its request and any tweak left with none, so its
  example, the changes a report quoted under it and its scoreboard numbers go too. A
  report read before then, or already running, is not recalled
  ([reports](reports.md#reads)).
- `forget_memos` takes 1 to 100 ids; when none is the account's, it is refused with
  `invalid_memo`. The result lists the ids forgotten.
- Deleting a tweak on the TPS page removes it with its citations; no stored change
  links to a tweak in this release.
- Removing a memo's request on the TPS page clears it; the memo stays.
- "Delete all memos" removes every memo, with its changes and request, and every tweak
  and kind, not the cover sheet.
- Citations go through the foreign keys' cascades, which run as the table owner; no
  runtime deletes citations itself ([database](database.md)).

## Disconnecting an AI

- The app persists a lifecycle UUID, the original account, subject, incarnation and
  client, and the requester association before the first native or remote attempt;
  retries never select current or recreated targets.
- Disconnect commits native original-binding refusal before bounded cleanup; a failed or
  unfinished step answers 503 with a retry page re-posting the same operation, as
  deletion does. Reconnecting creates a new binding and never revives an old token.

## Account deletion

- Destructive deletion requires authoritative native freshness, exact typed
  confirmation and retention of the current guarded verified-identity fingerprints.
- Deletion saves the current verified-identity fingerprints as it starts, then commits
  refusal, then Stripe cancellation, then writing erasure (which records no identity of
  its own), and finally bounded native cleanup. An unknown inventory or cascade shape
  leaves a retryable incomplete operation, and an incomplete operation is never
  presented as deleted.
- Writing and original-incarnation app credentials are never erased before Stripe
  cancellation succeeds. Without billing configured, deleting an account with a stored
  Stripe customer stops at the Stripe step and stays retryable.
- Account erasure removes memos (with their requests and changes), kinds, tweaks,
  citations, served-report records, the cover sheet and its versions, the Keep memos
  switch and usage rows, through cascades from `users`.
- A save's receipt outlives forgetting, so it holds only the changes' state and count,
  never a change's text or a request ([saves](saves.md#receipts)).
- Native refusal and the progress billing reads commit in one transaction. Once they do,
  nothing links a Stripe customer to the account (the link reads the deletion while
  holding the billing row). A customer Stripe made for a refused link is deleted at
  Stripe straight away, best effort (a failure is only logged), unless the row already
  holds it under the same idempotency key, when it is the deletion's to end.
- Stripe cancellation reads the customer holding that same row, so it waits for an
  enrolment in flight, and the erase ends any customer still linked, holding the row,
  before erasing, so an account is never erased with a live customer.
- Checkout reads the deletion again once its session is open, a finished deletion and an
  erased account included, and expires it (best effort) with a 409. A deletion that
  begins after that read still deletes the customer; whether Stripe then refuses to
  complete the open session is not verified at Stripe.
- Native cleanup deletes the account's sign-in grant bindings in the same step as the
  native user, after its codes, tokens, consents, sessions and sign-in methods (at most
  256 rows, the per-user cap `bind_flow` enforces), so no partial run leaves a user or
  credential without its binding. Every code, token, session or consent that named a
  missing binding is refused (each gate looks the binding up strictly), and the deletion
  record keeps `bind_flow` from making a new one.

## AI registrations

- Consenting to an anonymous AI registration writes a durable link from the account to
  it (`milton_guard.client_link`, native 008); disconnects, token and consent purges and
  binding expiry leave it, and the native user cannot be deleted while it exists.
- Deletion takes each link under the registration's lock: a registration no other
  account is linked to is deleted with its dependents, and one that is keeps working for
  them with its name and contacts cleared.
- Either way the SHA-256 of its client ID goes into `milton_guard.cleared_client` (no
  foreign key, kept indefinitely), and a trigger empties name and contacts on any later
  insert or update under that client ID, so neither a metadata-document refresh nor a
  rediscovered registration brings them back.
- Neither Milton nor its pages show a client name (consent shows the client ID,
  Connected AIs its host), so a cleared one changes no page.
- Native 008 backfilled links from existing consents, consented bindings and native's
  disconnect records, each matched to the user's recorded identity incarnation; a record
  for another incarnation counts as a deleted original identity's. It applied the same
  rule to registrations a deleted identity's remaining binding or disconnect record
  names, then dropped deleted identities' unreferenced bindings. It first locks every
  runtime table it writes in one statement that never waits (55P03 if any is in use; run
  it again), so no service transaction or cleanup can deadlock with it; it can still
  wait on another owner session (the ledger, owner DDL), which the runbook rules out.
- Kept indefinitely: registrations no account ever authorized, and ones whose only
  authorization before 008 left no consent, binding or disconnect record (revoked by the
  AI or left to expire, then pruned). `public.assistant_disconnects` has had no writer
  since native auth, so it names no native registration.

## What outlives an account

- Disconnects and identity hashes have no foreign key to users, so they outlive the
  account. Trial-eligibility fingerprints are retained after deletion
  ([accounts](accounts.md)).
- `docs/deletion-inventory.txt` classifies every text-bearing column the three migration
  tracks create as deleted by account deletion, hidden (kept, never served), retained
  (tied to no account, so deletion cannot remove it, such as anonymous client
  registrations) or not personal, with a reason. `server/test/deletion-inventory.test.ts`
  applies all three tracks to an empty PGlite and fails on any text, character, JSON,
  bytea, tsvector, XML or enum column (or array, domain or composite holding one), in a
  table or materialized view, missing from it.
