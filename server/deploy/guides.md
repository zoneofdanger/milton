# Private report guide pilot

**Parked 2026-11-07 (Peter): no further work; guides stay default-off.** Nothing is scheduled, keyed or enrolled. Resume only on his decision.

## Parked state and resume

A parked pilot costs nothing per request. Reads include guide state only when the
process sets `MILTON_GUIDES=on` (unset or any other value is off; app and MCP each read
it at startup): off, a cover-sheet, report or web-page read sends no statement naming
`report_guides` or `guide_accounts`, and envelopes and pages carry no guide. Drizzle
`0010_park_guides` drops the sample-version trigger `report_guide_source`, so saves no
longer touch `report_guides`. The function, the guide tables and their rows, the grants
and `milton_guide_worker` stay, and nothing is enrolled. 0010 changes no row and no code
needs the trigger, so apply it with the normal runbook (snapshot first,
`bun run --cwd server db:migrate` as `neondb_owner`) in either order with this code.

To resume, after Peter's decision:

1. Snapshot production.
2. From `server/`, with the owner URL already supplied securely in
   `MILTON_OWNER_DATABASE_URL` (no env-file fallback; it refuses any role but
   `neondb_owner`): `bun --no-env-file scripts/guide-enrollment.ts resume`. One
   transaction (`resumeGuides`, `src/guides/resume.ts`): it recreates the trigger and resyncs every account's guide rows. While
   parked nothing recorded which reports changed, so every report with an active sample
   queues on a new source version (its last guide kept as stale text) and every other
   guide row is cleared to `empty`/`no_samples`.
3. Check: `SELECT tgname FROM pg_trigger WHERE tgname='report_guide_source'` returns one
   row.
4. Set `MILTON_GUIDES=on` in the app and MCP payloads and deploy new revisions. Then the
   job, schedule and enrollment below, each separately authorized.

To park again, set `MILTON_GUIDES` off first, then run 0010 by hand:
`psql -1 -X -v ON_ERROR_STOP=1 -f server/drizzle/0010_park_guides.sql`.

This source build does not authorize deployment, provider calls or enrollment. Guides
default off. Apply the additive `0003_report_guides` migration only through the normal
hosting runbook, from the selected landed commit, with a database snapshot first.
It preserves approved sources and backfills source identities without enrolling anyone.
Local PGlite rehearsal covers populated upgrade, repeated apply and capability boundaries.
No down migration or compatibility layer is included in this pre-launch build.

## Services and credentials

App/MCP keep their approved-source responsibilities. Their `milton_runtime` role gets
SELECT only on `guide_accounts`/`report_guides`, no spend or enrollment/consent write privileges.
Only the owner-operated enrollment script can enable guides or update consent.
A scoped SECURITY DEFINER trigger updates report source/work state in sample transactions;
it has a fixed search path and no public executable grant. 0010 drops it while parked.

`milton_guide_worker` is a NOLOGIN capability role, separate from `milton_runtime`.
A future release may provision a plain NOINHERIT login whose only membership is that
capability, granted `WITH INHERIT TRUE`. Before contacting the provider, the worker
refuses any other membership (including the auth, app and MCP runtime roles), ownership,
DDL/TEMP path, `identities` read or usage of the native auth, app credential or retained
sign-in schemas:

| Tables                                                                        | Guide worker capabilities |
| ----------------------------------------------------------------------------- | ------------------------- |
| users, trial_accounts, samples, sample_versions, sample_kinds, guide_accounts | SELECT                    |
| report_guides, guide_budget_lock                                              | SELECT, UPDATE            |
| guide_spend                                                                   | SELECT, INSERT, UPDATE    |
| identities, assistant disconnects, cards, auth/credential tables              | None                      |

Do not grant this role to an auth service. Do not give the worker runtime/auth membership,
auth URLs, OAuth credentials, cookie secrets, signing keys or account mutation privileges.
Coordinate migration numbering and capability names with the independent auth-service
migration before integration; this task does not modify auth.

The image includes `server/dist/guide-worker.js`, built for Node 26. Configure a finite
Cloud Run Job, with command `node server/dist/guide-worker.js`, at most one scheduled
execution at a time and a ten-minute execution timeout. A future operator can schedule
it every five minutes; each execution processes at most five reports sequentially and
exits. No public endpoint, external queue service or polling workflow is needed.
Provisioning that job/scheduler is separate authorized release work; no live manifest
or cloud resource is changed here. Leases still protect each report if runs overlap.

Give this job its own dotenvx payload/key, containing only `GUIDE_DATABASE_URL` and
`ANTHROPIC_API_KEY` (`GUIDE_MODEL` may select only `claude-opus-5-5` in this pilot).
`MILTON_ENCRYPTED_ENV_FILE` and the platform-held dotenvx key load that worker-only
payload. Never mount the app/MCP/auth payload. The worker verifies its plain scoped
role before contacting the provider. Build/tests require no credentials or account.

## Enrollment and fences

After separately authorized explicit opt-in to Anthropic processing, an operator can
run the following from `server/` with an owner URL already supplied securely in
`MILTON_OWNER_DATABASE_URL`; the script never falls back to local environment files:

```sh
bun --no-env-file scripts/guide-enrollment.ts enable ACCOUNT_ID --consent-ref OPAQUE_CONSENT_REFERENCE
bun --no-env-file scripts/guide-enrollment.ts disable ACCOUNT_ID
```

Use an opaque consent-record reference, never private names or consent text. Enablement
records consent time/reference and advances an epoch; disable advances it too. No public
controls or per-guide approval step are added. Active accounts with subscription status
`active` or `trialing` with a future `trial_end` are eligible; unknown/missing billing,
expired trials and other statuses are not. Eligibility is checked before counting,
generation, spend reservation, activation and serving. An active subscription does not
enroll anyone. Existing nonempty reports are scheduled on enablement.

While the trigger is installed, work is recorded in the sample transaction even while disabled; rules do not invalidate
it. One report lease lasts 150 seconds, with a 90-second provider deadline and two attempts
per source/epoch. Failures retry no sooner than five minutes; expiry recovers durably.
Completion first locks the report row enrollment also updates, then evaluates its
source/epoch/lease fence in a fresh READ COMMITTED statement; this prevents a blocked
completion from reusing a pre-disable epoch snapshot. Zero active samples clear immediately;
valid insufficient evidence is a completed no-guide result whose reason survives exact-source reuse. Nonempty changes/failures retain
last successful stale text with explicit versions/reason. Off hides future presentation;
completed text may remain stored until deletion, and exact-source completed results may be
reused on re-enable. Content already read by another assistant cannot be retracted.

## Input, output and spending

All active current sample originals plus complete kind/context go in one request. Never
include rules, prior guides or retired revisions; never subset, truncate or content-batch.
The entire serialized request, prompt and output schema must fit a conservative 180,000
UTF-8 byte preflight bound and 200,000 provider-counted input tokens. Overflow is terminal
unavailable. Token counting is provider processing and therefore requires eligibility.

Opus 5.5 has no tools, low effort (its thinking cannot be disabled) and a versioned system
prompt with strict JSON output. Local validation checks completion/refusal, shape (thinking
blocks are ignored, never shown or stored; exactly one text block), at most eight bounded
tendencies, all stable-ID/revision references and a 6,000-character rendered cap. References validate
before activation but are omitted from human-readable guide text; source/current versions
remain in MCP metadata. The app shows tendencies/applicability, plain update/unavailable
reasons and a stale explanation, without source numbers or worker diagnostics. Insufficient evidence
must have no tendencies. There is no paid repair/second judge. Mechanical validation and
fake-provider tests cannot establish semantic truth or immunity to prompt injection.

Each generation atomically reserves $1.120000: the full 200,000 input-token ceiling
at $4/M plus the maximum 16,000 output tokens (thinking included) at $20/M, even for
tiny reports. The count endpoint supplies an estimate for the input admission check, not a guaranteed upper
bound, so it never reduces the reservation. Generation explicitly sets
`service_tier: "standard_only"`; the count payload omits that generation-only field.

The same singleton lock serializes reservations and recognized-usage settlement against
$20/global UTC month, $5/global UTC day and $2/account UTC day. Recognized returned usage
settles exactly once, upward or downward, even when the guide is refused, unfinished or
outside activation limits. Subsequent admissions see that recorded cost. Unknown outcomes
keep the full reservation across crashes/deletion. Content-free amount/time/account-hash
records outlive accounts; do not delete/reset these to permit retries.

These are conservative admission bounds and usage-derived accounting at the selected
rates, not independently invoiced costs or a guarantee over unrelated provider usage,
unexpected token counts, pricing changes or other provider billing anomalies. Known costs
above the reservation remain recorded honestly; accounting cannot undo an incurred charge.
Count requests are free but require eligibility. No caching, tools, batch or regional
premium is selected. Model/rate changes require a matching reservation review before use.

Official references checked 2026-11-06:
[Messages/token counting](https://platform.claude.com/docs/en/api/messages/count_tokens),
[token count estimates](https://platform.claude.com/docs/en/build-with-claude/token-counting),
[service tiers](https://platform.claude.com/docs/en/api/service-tiers),
[structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
[pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[standard API retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data).
Standard retention is within 30 days with policy/legal/contract exceptions, not a ZDR promise.

## Fictional comparison, later human observation

A tiny comparison can use approved fictional notes such as “The seedlings are ready.
Collect them on Saturday.” and “The pots are by the gate. Take two if you need them.”
Task prompt: “Write a short collection note: herb trays are ready, pickup Sunday,
bring a box. Use the supplied approved examples and rules.” Supply the same task,
original samples, rules and model/settings in both conditions; add only the derived
“Open with the practical update; state the collection action directly, for short pickup
notes” in the second. Generate neither condition during this build.

For later consented real tasks, randomize condition order and record time to a sendable
version, actual edits, preserved facts, and whether requested edit scope was respected.
Keep private writing out of the public repo. No fewer-edit or time-saving result is
claimed by this implementation or its fictional browser evidence. Provider behavior,
production scheduling, real-client adherence and human benefit remain future checks.
