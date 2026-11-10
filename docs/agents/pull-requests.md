---
name: pull-requests
description: What a Milton task PR records, and how checks and evidence carry across a handoff
type: rule
---

# Pull requests

- The PR is the authoritative task record: owner, scope, latest commit, checks and exit
  codes, findings, observed and unverified behavior, next action, and publishing
  authorization source and scope. Release reads it before dependent work. Before a PR
  exists, use one brief; afterward link the PR instead of duplicating status files.
- The PR states: behavior checked (the exact action, result and environment); not
  checked (the specific behavior left unverified, and why); and the next gate (the check
  required before a demo, release or further handoff). Never describe a report, a commit
  or a passing typecheck as proof of behavior nobody observed.
- Keep private information out of public PRs.
- Git preserves source history and CI records checks. Compare the reviewed commit with
  the selected commit; rerun affected checks for real changes, without repeating
  unchanged verification merely because ownership changes.
- Frozen snapshots, hash manifests and extra acceptance or delivery reports are
  exceptions for concrete risk, reproducibility or runbook needs, not default handoffs.
  Preserve existing artifacts and previews.
