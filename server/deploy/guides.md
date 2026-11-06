# Private report guide pilot

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
it has a fixed search path and no public executable grant.

`milton_guide_worker` is a NOLOGIN capability role, separate from `milton_runtime`.
A future release may provision a plain login with membership only in that capability:

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
`ANTHROPIC_API_KEY` (`GUIDE_MODEL` may select only `claude-opus-4-6` in this pilot).
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

Work is recorded in the sample transaction even while disabled; rules do not invalidate
it. One report lease lasts 150 seconds, with a 90-second provider deadline and two attempts
per source/epoch. Failures retry no sooner than five minutes; expiry recovers durably.
Source/epoch/lease checks prevent obsolete activation. Zero active samples clear immediately;
valid insufficient evidence is a completed no-guide result. Nonempty changes/failures retain
last successful stale text with explicit versions/reason. Off hides future presentation;
completed text may remain stored until deletion, and exact-source completed results may be
reused on re-enable. Content already read by another assistant cannot be retracted.

## Input, output and spending

All active current sample originals plus complete kind/context go in one request. Never
include rules, prior guides or retired revisions; never subset, truncate or content-batch.
The entire serialized request, prompt and output schema must fit a conservative 180,000
UTF-8 byte preflight bound and 200,000 provider-counted input tokens. Overflow is terminal
unavailable. Token counting is provider processing and therefore requires eligibility.

Opus 4.6 has no tools, disabled thinking and a versioned system prompt with strict JSON
output. Local validation checks completion/refusal, shape, at most eight bounded tendencies,
all stable-ID/revision references and a 6,000-character rendered cap. Insufficient evidence
must have no tendencies. There is no paid repair/second judge. Mechanical validation and
fake-provider tests cannot establish semantic truth or immunity to prompt injection.

Each generation atomically reserves the provider-counted complete-input tokens at $5/M
plus the maximum 4,096 output tokens at $25/M. For example, 100 input tokens reserve
$0.102900; 200,000 input tokens reserve $1.102400. A singleton lock serializes reservations against $20/global
UTC month, $5/global UTC day and $2/account UTC day. Count requests are not generation and
are not charged by Anthropic. Known bounded usage settles downward; unknown outcomes keep
their counted-input plus maximum-output reservations, including across crashes/deletion. Content-free amount/time/account-hash
records outlive accounts. Do not delete/reset these to permit retries. Caps are guide-pilot
caps, not a cap on unrelated provider usage. No caching, tools, batch or regional premium
is selected. Model/rate changes require a matching reservation review before use.

Official references checked 2026-11-06:
[Messages/token counting](https://platform.claude.com/docs/en/api/messages/count_tokens),
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
