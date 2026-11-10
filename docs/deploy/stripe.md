---
name: stripe
description: Operating Stripe for Milton: live mode, the Dashboard settings billing relies on, and the subscription backfill and resync
type: procedure
covers:
  - server/scripts/backfill-subscriptions.ts
---

# Stripe

Trials and billing are live (since 2026-11-04). No billing migration or trial flip is
pending. Keep the app's current encrypted payload and numeric secret references; the MCP
service gets no Stripe setting (admission's payload carries the Stripe key and price, see
[cloud](cloud.md#admission-service-milton-admit)). Owner changes to `store_config` and
subscription backfills are separate operations and need their own authorization.

## Stripe mode

Production runs on the live key, live webhook secret and live price. Test mode runs on a
disposable database only, never on production rows: a test id does not exist in live mode,
so no live event ever names that row, it stays `trialing` for free, and the portal fails for
that person. If a production row ever holds a test id, clear it. A key from the wrong mode
against real rows reads as a failed Stripe list: webhooks answer 503 and Stripe retries,
sign-ins stop with try again, nobody is marked canceled, and account deletion refuses rather
than leave a live subscription charging.

A row holding an id the key cannot see, such as a test id under a live key, refuses deletion
every time until an operator clears it, and that person's deletion request waits meanwhile.
First confirm the key is the right one: a wrong key is fixed, not worked around. Then clear
the row's `stripe_customer_id` and `stripe_subscription_id` and set `subscription_status` to
`canceled`.

## Stripe Dashboard settings

Live billing relies on these settings; check them after any change in the Dashboard.

Failed payments must be set to "Cancel the subscription" in both test and live mode. The
gate reads `unpaid` as expired and Checkout will not sell over it, and nothing confirms the
portal can settle it, so "Mark as unpaid" would lock out a paying person until support steps
in.

Payment methods come from the Dashboard's default payment method configuration, which is
Peter's. No code sets payment method types.

Stripe's customer emails are Dashboard settings too, and no code sends them. In live mode,
all three stay on:

- Trial-ending reminder: "Send a reminder email 7 days before a free trial ends", with the link
  to a Stripe-hosted page.
- Payment receipts: "Successful payments", under Customer emails.
- Failed-payment emails: "Send emails when card payments fail".

Stripe sends no trial reminders in a sandbox, so a test-mode run cannot confirm the first.

## Backfill

The subscription backfill gives existing accounts their trial. It runs from a checkout of the
released commit, after `bun install --frozen-lockfile`. The runtime image cannot run it: it
is Node with one bundled file, no `bun` and no `server/scripts`. Never run it from a checkout
older than `1694b1b` while the test account exists: that version counts the test account as
waiting (no trial row) and with `--apply` gives it a trial row and a live Stripe customer and
30-day trial for `e2e@milton-test.invalid` (its dry run only counts it). Set
`MILTON_ENCRYPTED_ENV_FILE` to the app's encrypted payload and `DOTENV_PRIVATE_KEY` to its
key, at the numeric versions the app mounts (`<env>` and `<key>` below). The script prints no
value. First the dry run:

```sh
umask 077
dir="$(mktemp -d)"
gcloud secrets versions access <env> --secret=milton-app-env --project=milton-510506 > "$dir/app.env"
export MILTON_ENCRYPTED_ENV_FILE="$dir/app.env"
export DOTENV_PRIVATE_KEY="$(gcloud secrets versions access <key> --secret=milton-app-key --project=milton-510506)"
cd server
bun --no-env-file scripts/backfill-subscriptions.ts
```

Read the counts. Then, in the same shell:

```sh
bun --no-env-file scripts/backfill-subscriptions.ts --apply
cd ..
unset MILTON_ENCRYPTED_ENV_FILE DOTENV_PRIVATE_KEY
rm -rf "$dir"
```

It prints only counts (total, created, skipped, failed, still NULL), at about 5 accounts a
second, over active accounts other than test accounts (it reads `users.test_account`), and
refuses without `trials_enabled` and a live key. `--allow-test-key` is for disposable
databases only. With `--apply` it exits nonzero if any account still has no status; rerun
it, since rows with a status are skipped. A returning deleted identity's row is canceled and
counted as skipped. A row left at NULL is free until a browser sign-in: an approval Neon
already holds refreshes without any Milton page. A customer it creates has no email until its
person first opens billing, when Milton copies their sign-in email to Stripe. Everyone who can
add a card or pay passes through there, so nobody is charged without one unless the copy
fails or sign-in supplied no address; until then Stripe sends that person nothing, including
its trial-ending reminder.

## Resync

`--resync` (same setup, guards and pacing) instead re-reads every stored customer of a
non-test account from Stripe and writes what it finds through the webhook's compare-and-set
on `trial_accounts.stripe_revision`, with no event; it prints total, reconciled and failed,
calls Stripe for nothing without `--apply`, and exits nonzero when any failed (a read failed
or a write conflicted twice): rerun it until it exits 0. Run it after any window in which a
stored Stripe state may be stale, such as old and new code writing it side by side (as at
#70's release, [history](../history.md)): checkout sends a stored trialing, active, past_due,
unpaid or paused status to the portal without reading Stripe, so a stale state would last
until that customer's next Stripe event.

```sh
bun --no-env-file scripts/backfill-subscriptions.ts --resync
```

Then the same with `--apply`.
