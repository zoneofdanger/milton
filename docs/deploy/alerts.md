---
name: alerts
description: Milton's production alerts as code: each policy, its threshold and reason, the release gate, and how monitoring.ts plans and applies them
type: reference
covers:
  - server/deploy/monitoring/**
  - server/scripts/monitoring.ts
---

# Alerts

Alerts are code: [server/deploy/monitoring/](../../server/deploy/monitoring/) holds one JSON
file per resource in the Monitoring and Logging APIs' own shapes (`*.metric.json`,
`*.uptime.json`, `*.policy.json`), and each policy's `documentation` says what to check first
and why each threshold is what it is. [`server/scripts/monitoring.ts`](../../server/scripts/monitoring.ts)
plans by default and changes nothing; `--apply` upserts by display name (log metrics by
name), then deletes only the ten hand-made policies it names (`milton-*-5xx-ratio`,
`-latency-p95`, `-instances`, `-errors-log` and `milton-auth-jobs-errors-log`), which stayed
live until the first apply. A second `--apply` changes nothing. It accepts a missing
`pending/` folder. It refuses any notification channel other than `milton-ops-email` (email,
Peter's address), which it looks up by display name. Only the release coordinator applies,
after review:

```sh
bun server/scripts/monitoring.ts            # plan: create/update/unchanged/delete per resource
bun server/scripts/monitoring.ts --apply    # release coordinator only
```

Delivery was tested on 2026-11-08: a temporary always-true policy opened one alert and Peter
confirmed the one email arrived.

Two tiers. **Page** policies email `milton-ops-email` once per incident (`notificationPrompts:
[OPENED]`, no renotify; the API implements `notificationRateLimit` only for log-match
conditions, and none remain) and close 30 minutes after the condition clears. **Gate**
(`milton-release-gate`) has no channel and emails no one; the release gate in
[releases](releases.md#verify) reads it. Traffic is about 8 to 25 requests an hour, far too
low for ratios (one 5xx in five requests is 20%), so conditions count over a window.
Baselines and backtests: 7 days to 2026-11-08 06:30Z, Monitoring and Logging APIs; no page
condition would have fired except the two no-execution ones, during the real incident noted
below.

| Policy (tier)                                    | Condition                                                                                                                         | Reason                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `milton-uptime` (page)                           | `/health` (app, MCP) and `/api/auth/ok` (auth), every 5 min from 3 US regions, 10 s timeout; failing from ≥ 2 regions for 10 min  | One region can fail alone; two consecutive rounds rule out a dropped probe. Not backtested: the checks are new. Uptime conditions are never charged.                                                                                                                  |
| `milton-app`, `milton-mcp`, `milton-auth` (page) | 5xx ≥ 10 in a rolling 15 min, held 5 min                                                                                          | 7-day worst: 6 (app, a release's 503s, 11-04), 0 (MCP), 1 (auth).                                                                                                                                                                                                     |
| same                                             | p95 over a rolling 5 min > 5 s, held 30 min; no data, no alert                                                                    | 40 to 70× the median 5-min p95 (116 / 72 / 81 ms); the longest 7-day run above 5 s was 5 min. The specified 30-min window was rejected: one 7.8 s scanner request (`GET /?p=1`, app, 11-04 16:00Z) held it above 5 s for 30 min at this traffic and would have paged. |
| same                                             | `milton-errors` (ERROR log entries) ≥ 10 in a rolling 15 min, held 5 min                                                          | 7-day worst: 6 (app), 3 (MCP), 3 (auth). Each 5xx is also an ERROR request-log line, and deploy errors are ERROR audit lines.                                                                                                                                         |
| same                                             | instances > 8 for 15 min                                                                                                          | 7-day max 3 / 4 / 3 (one kept warm). A traffic spike, not a failure.                                                                                                                                                                                                  |
| `milton-jobs` (page)                             | `milton-auth-mail` ≥ 5 failed executions in 15 min                                                                                | 1,262 succeeded and 0 failed in 7 days; one failure is retried by the next minute's run.                                                                                                                                                                              |
| same                                             | `milton-auth-maint` ≥ 2 failed executions in 45 min                                                                               | Two consecutive 15-minute runs; 84 succeeded and 0 failed in 7 days.                                                                                                                                                                                                  |
| same                                             | no `milton-auth-mail` execution for 20 min                                                                                        | Catches a broken trigger, which fails no execution. Would have fired once, 11-07 07:43Z, during the real two-hour `:run` → `un` incident.                                                                                                                             |
| same                                             | no `milton-auth-maint` execution for 45 min                                                                                       | Three missed 15-minute runs: a broken maintenance trigger, which fails no execution. 7-day longest gap otherwise 31 min. Would have fired once, 11-07 08:09Z, in the same incident. With this, deleting `milton-auth-jobs-errors-log` loses no coverage.              |
| `milton-auth-mail` (page)                        | ≥ 3 failed or throttled sends combined in a rolling 15 min (`milton-auth-mail-problems`)                                          | Peter asked not to be spammed, and one blip should not page; a sustained key, sender or throttle problem crosses 3 within a quarter-hour. Baseline 2,778 passes, 0 failed, 0 throttled (11-07 to 11-09).                                                              |
| same                                             | ≥ 1 delivery pause over 15 min set by a 429 (`milton-auth-mail-long-pause`)                                                       | An outage of real people's mail, not a blip, so one event pages: queued mail expires before the pause ends and later passes log nothing. Covers a quota 429, which never reaches 3.                                                                                   |
| `milton-instance-start` (page)                   | `milton-startup-failures` ≥ 3 in a rolling 15 min, per service                                                                    | Cloud Run system log lines `Default STARTUP TCP probe failed …` and `Container called exit(N).` (N ≠ 0); a failed start writes both. 30-day worst: 2 (auth, 11-07 08:30Z, one failed start that recovered in 8 s).                                                    |
| `milton-e2e-daily` (page)                        | ≥ 1 failed `milton-e2e-daily` execution in 24 h                                                                                   | Each run is a full end-to-end pass, so one failure is the signal.                                                                                                                                                                                                     |
| same                                             | no `milton-e2e-daily` execution for 13 h                                                                                          | Runs are 12 hours apart, plus an hour of margin; alignment plus duration (14 h) stays inside the API's one-day absence limit.                                                                                                                                         |
| `milton-release-gate` (gate)                     | per service or job, rolling 5 min: any 5xx; any ERROR entry; any failed `milton-auth-*` execution; any startup failure; ≥ 10 429s | Fast and loud by design; emails no one. 429 needs 10: MCP had a 48-request 429 burst on 11-07 10:55Z.                                                                                                                                                                 |

The startup signal is the log-based metric, not `run.googleapis.com/container/completed_probe_count`:
that metric did not record the one real failed start in 30 days, because the container exited
(`Error: Connection terminated due to connection timeout`) before the probe completed.
The deploy errors of 2026-11-08 01:00Z (`traffic[21].tag: must be at least 3 characters`,
`Revision 'milton-*-r3-64435ee' does not exist`) and 11-07 23:23Z (`Deadline expired`) are
ERROR audit entries on the service, so they count in `milton-errors` and open the gate.

`milton-admit` is in `milton-errors`, `milton-startup-failures`, milton-instance-start and
the release gate, but has no page policy or uptime check of its own: it has no health
route and refuses unauthenticated probes, and a failing admission is a failing sign-in,
which auth answers with 503 and milton-auth's 5xx condition pages (its documentation
points at milton-admit). No new condition, so no added cost.

**Mail job logs.** `milton-auth-mail` logs each pass as one JSON line
(`{"message":"auth_mail_pass",…}`), one line per failed or throttled send
(`{"message":"auth_mail_send","outcome":…}`) and one per pause a throttle sets
(`{"message":"auth_mail_pause","seconds":N}`). The two mail metrics count those (Peter's
thresholds, 2026-11-09). The pause metric's numeric comparison (`jsonPayload.seconds>900`) is
unverified against live entries until the first throttle. After a domain check or the
per-address cap refuses a send, milton-auth's log shows `auth_mail_skipped`
(`undeliverable_domain`) or `account_cap`.

**Missed runs.** A metric-absence condition can look back at most one day in total
(alignment period plus duration; the API refuses durations over 23h30m), so the 26-hour
window a once-a-day run needed was refused. The check runs every 12 hours, and the policy
pages after 13 hours with no execution. An absence condition needs one data point after
it is created or changed: after editing it, run the job once if the last run is more than
about 12 hours old, or it fires on the stale gap. Likewise, apply a new failure condition
only after an old failure has left its window, or it emails a stale failure.

**Key renewal.** The daily check's `WARNING` line
(`jsonPayload.warning="key_expires_within_30_days"`) is there for a renewal alert if one is
wanted; none is applied.

Cost: free until no sooner than 2027-09-01, then $0.35 per non-uptime condition per month
(26 applied, about $9.10) plus $0.50 per million points.
Uptime checks run about 78k times a month against a free million. Stripe's webhook-failure
emails and Neon's compute alerts are Dashboard settings, not these policies.
