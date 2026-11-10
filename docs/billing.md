---
name: billing
description: Trials, the one plan and Stripe (checkout, portal, webhook), access by subscription status, trial notices, store limits and usage rows
type: behaviour
covers:
  - server/src/billing.tsx
  - server/src/store/billing.ts
  - server/src/store/trials.ts
  - server/src/store/usage.ts
  - server/src/store/index.ts
  - server/src/store/limits.ts
---

# Billing

## The plan

- One plan: USD $5.01 a month, no per-AI fees, set in Stripe and named by
  `STRIPE_PRICE_ID`, after a 30-day trial that Stripe owns. The price and trial length
  shown in copy come from `packages/theme/facts.ts` ([setup](setup.md)).
- Milton stores only Stripe's ids, status and dates and a reminder milestone; no
  payment details enter these records.
- Stripe's retry settings, retention duration and paid allowances still require
  selected policies.

## Access

- Trials are switched by `store_config.trials_enabled`, off by default in a new database;
  when off, everyone is early access. Production has had trials and billing on since
  2026-11-04.
- With trials on, access follows the Stripe subscription status held on the trial row:
  trialing reads as trial, active as paid, and past_due as paid for 3 days from the
  renewal.
- Past that grace, canceled, unpaid, incomplete, incomplete_expired and paused read as
  expired.
- No row, no status, or a status Milton does not know reads as early access, so a Stripe
  outage never cuts off a connected AI, and reads never call Stripe.
- Expired accounts are refused for AIs with `subscription_required` (`retryable: false`),
  whose message carries the one link, the signed-in app home; the web view and download
  stay open. This is not an authentication failure or an empty report. New saves are
  checked under the account lock, in the transaction that would commit them
  ([saves](saves.md)); exact replay still recovers an already accepted receipt.
- A test account (`users.test_account`) is permanently exempt from trials and billing,
  checked explicitly on each path, not only by its missing trial row: it always reads as
  early access whatever row it holds, sign-in starts no subscription for it, checkout and
  the portal answer 409, account creation, the backfill and the returning-identity
  cancellation never give it a row or status, the webhook never writes its row and no
  trial notice is offered. So no path creates a Stripe customer for one.

## Starting a trial

- With trials on, a new account gets a `trial_accounts` row at admission
  ([accounts](accounts.md)), and the subscription backfill gives existing accounts
  theirs ([hosting](hosting.md)). The row's `started_at` is the account's creation time,
  which nothing reads; Stripe's `trial_end` ends the trial. `paid_through` is unread.
- A trial row with no status gets the 30-day Stripe trial when billing is configured; no
  row, no status or billing disabled calls no Stripe API.
- Subscription creation locks the trial row across customer, list and create;
  minute-based idempotency keeps the known remote-success/local-timeout ambiguity across
  a minute boundary.
- Billing failures stop admission with a retryable 503; existing Stripe state is listed
  and reconciled before another create.
- An approval the native provider already holds refreshes without any Milton page, so
  existing accounts depend on the backfill.

## Trial notices

- A trial notice is claimed once per stage, 7 days and 1 day before `trial_end`, only
  while trialing, and carries the one link, the signed-in app home.
- One atomic account-wide claim offers each stage at most once across AIs and tools;
  returning during the last day skips the earlier reminder. The claim runs with a 250 ms
  lock and 500 ms statement limit, and a lost response or failed claim can lose a
  reminder. Delivery does not establish display or acknowledgment.
- Every MCP tool may attach the notice as a separate `notice` object on a successful
  result. A read or save whose trial gate found no reminder due makes no claim; a
  replayed save, which never reaches the gate, always tries one. The notice can never
  fail the call.
- Report text, versions, downloads and saved receipts contain no billing notices, and the
  website banner does not consume MCP reminders.

## Stripe

- The three Stripe settings are all or nothing: any one set means all three must be
  valid, or the app fails at startup. With billing unset, both billing routes and a POST
  to the webhook answer 503.
- Every Stripe call uses a pinned API version and a 5-second timeout, through Milton's
  own fetch client rather than the Stripe SDK, which keys and retries POSTs on its own.
- Only the app service routes `/billing/webhook`, ahead of the browser pages, so no
  session, cookie or CSRF check reaches it.
- The webhook takes only POST with a JSON body, and a signature more than 5 minutes old
  fails.
- The webhook verifies the signature with the official `stripe` package, then takes only
  a customer ID from the six handled event types, because Stripe does not guarantee
  event order.
- A handled event Milton cannot parse gets a 400 unrecorded, so Stripe retries it.
- For a customer Milton holds, the webhook reads the customer's subscriptions from
  Stripe with no transaction open, then writes the deciding one where it records the
  event, only if the row's `stripe_revision` (which every write of the Stripe state by
  Milton's code advances, even with unchanged values) is what it was before the read,
  so an older read never lands over a newer one; on a change it reads once more, and a
  second change answers 503 unrecorded.
- The deciding subscription is active, then trialing, then past_due, otherwise the
  newest.
- Only a successful empty list with a stored subscription writes canceled.
- Any non-2xx from Stripe's list, 404 included, is a failed read: the webhook answers 503
  unrecorded so Stripe retries, and sign-in stops with try again.
- A replayed event, an unknown type, or a customer Milton does not hold calls nothing.
- `stripe_events` keeps each event's ID, type and body hash, never the payload.
- The next request rechecks access, so reconnecting an AI after a status change is
  unnecessary.

## Checkout and portal

- Both billing routes take only signed-in POST forms with the CSRF check.
- `/billing/checkout` answers 409 to an account with no trial row.
- Once an account's deletion has begun, both billing routes answer 409 before any Stripe
  call, and enrolment refuses it with 409 `account_deleting`, not try again, whether the
  deletion began before or during it; the backfill counts it as skipped. Billing reads
  the deletion from the lifecycle row, which outlives the erase, and reads an account
  that is gone as being deleted ([deletion](deletion.md)).
- `/billing/checkout` sends trialing, active, past_due, unpaid and paused to the Stripe
  portal.
- With a stored customer, it lists Stripe first, with no transaction open, and goes to
  the portal if any such subscription exists, storing it as the webhook does (over an
  unchanged revision, one re-read, then 503); an empty answer is checked against the
  revision too, so a late webhook or a write during the read cannot sell a second
  subscription.
- An account still waiting on its trial takes it first, then the portal, or a 503 if it
  did not start, so paying early cannot lose the 30 days. In the portal, a card takes
  effect at `trial_end`.
- Any other status gets Checkout in subscription mode, card required, no trial; each
  session expires after 31 minutes (Stripe's 30-minute minimum plus a minute), not 24
  hours.
- `/billing/portal` sends an account with a stored customer to the Stripe portal, and
  answers 409 without one.
- Before sending anyone to Stripe, both routes copy the sign-in email to a stored
  customer (Checkout before it creates its session, the portal while it creates its
  own), so a backfilled customer gets one before it can add a card; a failed copy is
  logged and never stops anyone paying.
- Both routes leave through a page that navigates, because `form-action 'self'` blocks
  an external redirect after a form.
- A Stripe session URL is used only if it starts with Stripe's checkout or portal host.

## In the app

- With billing configured, the account menu on every signed-in page offers Add a card in
  a trial, Subscribe when expired, and Manage billing when paid; early access shows
  nothing. If the status read fails, the page still renders, with no billing item.
- A note above the TPS page shows only in a trial's last 7 days or when expired, with the
  same button; it shows nothing when paid or earlier in a trial.
- Without billing configured there are no buttons.

## Store limits

- Limits live in a single `store_config` row and are validated on read; invalid limits
  refuse every MCP call and sign-in, but no memo bound reads them ([memos](memos.md)).
- The runtime role can read and lock the `store_config` row but cannot change its
  settings.

## Usage

- There is no daily call or save allowance. A `tools/call` is admitted after access,
  scope and the store limits (the request's access statement), the input schema, the
  `get_report` intent and `kind_id`, and the trial and billing gate, right before the
  tool's own work (the read, or a save's decision under its account lock). Every refusal
  before that, `subscription_required` included, records nothing, and replaying a save
  receipt is not admitted. Admission is tracked per tool call, so calls sharing a request
  or a server are recorded independently.
- Each admitted call starts one `usage_calls` row (account, time, tool) at admission, on
  its own connection alongside the call's work; the reply waits for it at most 250 ms,
  then goes and lets the row finish in the background. Outcomes stay in the
  identity-free logs.
- One writer per process sends at once when idle and batches rows that arrive meanwhile
  (up to 50), holds at most one pooled connection, drops rows beyond 1,000 waiting, and
  logs a failure by class and code only; shutdown waits for it before closing pools.
- Each batch is one autocommit statement that never waits on an account row lock: it
  takes the key share of each batch account it can lock now (`SKIP LOCKED`) and inserts
  only those accounts' rows, so it holds key shares only on accounts it writes, only
  while it runs. A row skipped behind its account's `FOR UPDATE` is retried once, 50 ms
  after its own skip, then dropped and logged by code. `SKIP LOCKED` covers row locks
  only: a migration holding a table lock on `usage_calls` or `users` can delay usage rows
  (as it delays requests), while each reply still waits at most 250 ms.
- Usage is best-effort. A row is lost when it is skipped again on its retry (its account
  still under `FOR UPDATE`, or erased), when more than 1,000 rows are waiting, when its
  statement fails, or when the process exits (the 8 s shutdown bound or a crash) with
  rows still queued.
- The row's foreign key cascades from `users`, so account erasure removes it. Writers
  lock the account `FOR NO KEY UPDATE` ([saves](saves.md)), which the row's key-share
  check does not wait on; sign-in, eligibility, lifecycle and deletion lock
  `FOR UPDATE`, so a row for an account being deleted is skipped, then dropped, and
  never outlives the account.
- Usage rows are kept 90 days. Only the auth maintenance job (every 15 minutes, as
  `milton_auth_owner`) deletes older ones, through `public.prune_usage_calls` (`0008`):
  oldest first by the `at` index, at most 1,000 per batch and 20,000 per run, skipping
  rows an erasure has locked. Each batch is one transaction with one DELETE under
  server-side 10 s statement and 2 s lock limits, read back first; unset, it refuses. No
  request path deletes usage rows.
- Usage rows include the test account's calls; the counts that exclude it are in
  [server/README.md](../server/README.md).
