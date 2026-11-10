---
name: e2e
description: The fictional test account and the twice-daily end-to-end check against production: provisioning, the run, the job, key renewal
type: procedure
covers:
  - server/scripts/e2e.ts
  - server/scripts/e2e-http.ts
  - server/scripts/test-account.ts
  - server/deploy/monitoring/milton-e2e-daily.policy.json
---

# End-to-end check

`e2e@milton-test.invalid` is a fictional account that holds nothing but what the daily
end-to-end check writes and retires. `.invalid` is a reserved top-level domain no mail
system delivers to; the account is created verified, and auth never queues any mail (reset,
verification or other) for a `.invalid` address, answering such a request exactly as any
other, so nothing for it reaches the mail queue or Resend. Usage and metric counts exclude it
(`users.test_account`, [billing](../billing.md#usage)).

Trials stay on, and the account is permanently exempt from them and from billing, so its
access never depends on a trial or a Stripe customer. With billing configured, a trial row
with no status gets a Stripe customer and a 30-day trial at sign-in (`ensureSubscription`),
which would put a fictional customer in live Stripe and lock the account out when that
trial ended without a card. So provisioning creates the Milton account itself, marked and
without a trial row, before the native user exists, and every billing path checks
`test_account` explicitly ([billing](../billing.md#access)): the gate reads it as early
access, sign-in starts nothing, checkout and the portal answer 409, and no path gives it a
row, status, customer or notice.

The account, the check and the job were set up on 2026-11-08 (#57 and the daily check;
[history](../history.md#2026-11-08-test-accounts-drizzle-0009-owner-file-011-pr-57)). The
steps below are what re-creating any of them takes. Each command touches production: the
release coordinator runs them with Peter's go.

## Provision the account

Owner-only, from a checkout of the released commit after `bun install --frozen-lockfile`,
in a shell that keeps no history (zsh: `HISTFILE=/dev/null zsh`), with the owner URLs read
into the environment, never typed on a command line:

```sh
umask 077 && mkdir -p ~/keys
# AUTH_OWNER_DATABASE_URL: milton_auth_delegate assuming milton_auth_owner, as for
#   native migrations (options=-c%20role%3Dmilton_auth_owner).
# MILTON_OWNER_DATABASE_URL: neondb_owner, as for db:migrate.
bun --no-env-file server/scripts/test-account.ts --apply ~/keys/milton.test-account.env
unset AUTH_OWNER_DATABASE_URL MILTON_OWNER_DATABASE_URL
```

Before any write it refuses an existing file, an email native already holds, an address
outside `.invalid`, a wrong owner role on either connection and a database without 0009.
Then, printing one JSON line per step (`step`, `ok`, `ms`; never a password, key, cookie
or URL): it writes `E2E_EMAIL` and a random `E2E_PASSWORD` to the new mode-0600 file;
chooses the native user id and, in one owner transaction, creates the marked Milton
account without a trial row and its identity bound to that id; only then creates the native
user and its password credential in one owner transaction (native's own scrypt hash), the
step that makes sign-in possible, so no one can ever sign in to an account that is not
already marked and trial-free; checks that binding again; signs in over HTTPS exactly as a
browser does (app `/login`, the auth sign-in page and form, the app's code flow) and checks
the app shows this account; mints a read-and-save key expiring in 365 days through the
app's key form; checks as the owner that exactly this account is marked, active, without a
trial row and holds that key; and appends `E2E_CONNECTION_KEY`. Exit 0 only when every
step passed.

If any step fails, never sign in by hand. Fix the cause and run the same command with
`--resume` added and the same file: it reads the file's password, refuses a file that
already holds a key, binds or finds the marked, trial-free account (adopting the one marked
account a failed run left without its native user, refusing an unmarked one), creates the
native user only if it is missing, verifies the binding and only then signs in and mints the
key. The rehearsal fails a run before the Milton account's commit and between the two
commits (nobody can sign in afterwards), and after a native commit that succeeded but whose
acknowledgment was lost (the native user exists, bound to the marked account); `--resume`
finishes each. A plain env file, not dotenvx: dotenvx would keep its private key next to
the file in the same 0600 directory and protect nothing more, and `~/keys` already holds
plain owner files.

While the test account exists, keep auth at a release that never queues mail to `.invalid`
addresses (every release at or above auth's floor in [serving](serving.md) does), and never
run the subscription backfill from an old checkout ([stripe](stripe.md#backfill)).

## Run the check

**Snapshot gate.** Each run writes to production (only to the test account, but writes all
the same). Before the first production run, by hand or by the job, confirm a Neon snapshot
taken since 0009 was applied exists and record its name; if none does, take one first.
Later daily runs need no new snapshot.

From a checkout, with no owner or service credential in the environment:

```sh
bun --no-env-file server/scripts/e2e.ts ~/keys/milton.test-account.env
```

It uses only the file's three values and production's public HTTPS endpoints. Steps, each
one JSON line (`step`, `ok`, `ms`, `severity`; never a password, key, cookie or sample
body), each request bounded at 15 s:

1. `secrets`: the email must end `.invalid` and the key be well formed.
2. `sign_in`: app `/login`, the auth sign-in page and form, the code flow; the app must show
   "Signed in as" this email.
3. `key_owner`, before any MCP request: Connected AIs must show this email and list
   this key's public id, or the run stops with `key_not_on_account` and the key is never
   sent, so another account's key supplied by mistake is never authenticated or marked
   used. It reports `key_days_left` and, under 30, `warning: key_expires_within_30_days` at
   severity `WARNING` without failing.
4. `mcp_connect`: initialize with the key; `tools/list` must list exactly `create_memo`,
   `get_cover_sheet` and `get_report`.
   `safety_gate`, before any write: the cover sheet must be empty with no tweaks, and every
   memo must be one of the check's (kind `e2e check`, summary `Milton e2e check, run …`), at
   most five. Anything else stops the run with `account_holds_foreign_data`, having written
   nothing.
5. `forget_leftovers`: forgets marked memos a crashed run left, reporting the count.
6. `baseline`: the account must now be empty; its cover sheet version is the baseline.
7. `save_memo`: `create_memo` saves a fictional final-only memo marked with this run; it
   must come back as kind `e2e check`, tier `own`, receipt `Kept memo: e2e check, your words.`
8. `fresh_read`: a new MCP session's `get_report` must serve exactly that memo, its
   situation line and its words.
9. `forget_memo`, `cleanup`: `forget_memos` removes it; a new session must read an empty
   account (no memos, no tweaks, an empty report) with the baseline's version.

Exit 0 only when every step passed; otherwise the last line names the failing step and a
fixed error code, and the exit is 1.

**Footprint per run**, measured on the rehearsal (`auth-integration.ts` asserts it). No memo
stays: the run saves one and forgets it. Rows that stay as long as the account: 2
`save_requests` receipts (save, forget) and 3 `served_reports` (three reads), about 10 small
rows a day; one `memo_kinds` row on the first run only; no cover sheet, tweak or citation. A
crashed run's leftover forget adds one more receipt. Pruned: 8 `usage_calls` rows (deleted
after 90 days). Short-lived auth rows: one native session
(7 days), one app session (1 hour), one admission correlation (1 day), the app's code-flow
token and binding rows, all removed by expiry, later sign-ins and the maintenance job; at most about eight native sessions are live at once,
under the 64-per-user cap. The key's `last_used_at` is updated. Nothing is mailed and
nothing calls Stripe.

## The job: `milton-e2e-daily`

The same pattern as `milton-auth-mail` and `milton-auth-maint` (explicit `gcloud` commands,
a pinned image digest, numeric secret versions, a scheduler job created paused), sharing
nothing with them but the scheduler's invoker. Project `milton-510506`, region `us-east4`.

- **Image.** The runtime image (`server/Dockerfile`) carries `server/dist/e2e.js`, the check
  bundled for Node with the MCP SDK and no database driver. It runs the same image as app
  and MCP, and moves with them at every release and rollback ([releases](releases.md)).
- **Exit.** 0 only when every step passed; 1 for a refused gate, a failed step, a crash or a
  run past 240 s; one task, `--max-retries=0` and a 300 s task timeout, so one failure is
  one failed execution. Each stdout line is JSON with `severity`, which Cloud Logging reads
  as the entry's severity: the failing step's line is `ERROR`, an expiring key `WARNING`.
- **Identity.** Its own service account, `milton-e2e@`, with `secretAccessor` on its own
  secret only: no database URL, no other secret, no project role. The check uses only the
  public HTTPS endpoints.
- **Schedule.** Twice a day at 02:07 and 14:07 UTC (`7 2,14 * * *`; daily at 14:07 until
  2026-11-09, Peter's go): off the maintenance job's quarter-hour starts (`*/15`). Twelve
  hours apart, so the 13-hour missed-run alert fits the API's one-day absence limit.
- **Alerts:** at least one failed execution of `milton-e2e-daily` in 24 hours, or no
  execution for 13 hours ([alerts](alerts.md)).
- **Cost.** About a minute of one vCPU per run, inside Cloud Run's free tier; the writes
  above.

To re-create it, first the identity and the secret from the provisioned file, which is never
printed (`--data-file` reads it):

```sh
P=--project=milton-510506
SA=milton-e2e@milton-510506.iam.gserviceaccount.com
gcloud iam service-accounts create milton-e2e $P --display-name='Milton daily e2e check'
# Match the replication of the existing secrets (gcloud secrets describe milton-auth-owner-url).
gcloud secrets create milton-e2e-account $P --replication-policy=automatic
gcloud secrets versions add milton-e2e-account $P --data-file="$HOME/keys/milton.test-account.env"
# Expect version 1.
gcloud secrets versions list milton-e2e-account $P --format='value(name,state)'
gcloud secrets add-iam-policy-binding milton-e2e-account $P \
  --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
```

The job (`gcloud run jobs create` does not execute it; do not add `--execute-now`), on the
image app and MCP serve:

```sh
gcloud run jobs create milton-e2e-daily \
  --project=milton-510506 --region=us-east4 \
  --image=us-east4-docker.pkg.dev/milton-510506/milton/runtime@sha256:<STEP_4_DIGEST> \
  --service-account=milton-e2e@milton-510506.iam.gserviceaccount.com \
  --command=node \
  --args=server/dist/e2e.js,/run/milton-e2e/account.env \
  --set-secrets=/run/milton-e2e/account.env=milton-e2e-account:1 \
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=300s \
  --cpu=1 --memory=512Mi \
  --labels=app=milton,component=e2e
gcloud run jobs add-iam-policy-binding milton-e2e-daily \
  --project=milton-510506 --region=us-east4 \
  --member=serviceAccount:milton-auth-cron@milton-510506.iam.gserviceaccount.com \
  --role=roles/run.invoker
gcloud run jobs execute milton-e2e-daily --project=milton-510506 --region=us-east4 --wait
```

The first execution must succeed, its last log line `{"step":"done","ok":true,…}`. Then the
trigger, created with a schedule that cannot fire soon, paused, then given its real schedule
while paused (`gcloud scheduler jobs create http` has no `--paused` flag):

```sh
gcloud scheduler jobs create http milton-e2e-daily \
  --project=milton-510506 --location=us-east4 \
  --schedule='0 0 1 1 *' --time-zone=Etc/UTC \
  --uri=https://run.googleapis.com/v2/projects/milton-510506/locations/us-east4/jobs/milton-e2e-daily:run \
  --http-method=POST \
  --oauth-service-account-email=milton-auth-cron@milton-510506.iam.gserviceaccount.com \
  --max-retry-attempts=0 --attempt-deadline=30s \
  --description='Milton daily end-to-end check on the fictional test account'
gcloud scheduler jobs pause milton-e2e-daily --project=milton-510506 --location=us-east4
gcloud scheduler jobs update http milton-e2e-daily --project=milton-510506 --location=us-east4 --schedule='7 2,14 * * *'
gcloud scheduler jobs describe milton-e2e-daily --project=milton-510506 --location=us-east4 \
  --format='value(state,schedule,httpTarget.uri)'
# required: PAUSED  7 2,14 * * *  …/jobs/milton-e2e-daily:run   (the URL must end in :run)
gcloud scheduler jobs resume milton-e2e-daily --project=milton-510506 --location=us-east4
```

Apply its alert only after a passing run, so its failure condition does not email a stale
failure ([alerts](alerts.md)). To stop the check for a while (for example while code that
cannot pass it serves), pause the trigger with the `pause` command above and `resume` it
afterwards.

## Renew the key

Renew the key before it expires (the check warns from 30 days out): sign in to the app as
the test account with the file's password, create a new 365-day read-and-save key, replace
`E2E_CONNECTION_KEY` and revoke the old one. A renewed key is a new secret version:
`gcloud secrets versions add` from the updated file, then
`gcloud run jobs update milton-e2e-daily --set-secrets=/run/milton-e2e/account.env=milton-e2e-account:<n>`
(region and project as above), then disable the old version.
