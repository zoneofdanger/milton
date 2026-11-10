---
name: serving
description: What runs in production now: each service's revision, image and secrets, the rollback targets and floor, schema heads and snapshots to keep
type: status
covers:
  - server/deploy/admit.service.json
---

# Serving now

Rewritten in place by the release coordinator at every release, never appended to; the
release's record goes in [history](../history.md). How to release and roll back:
[releases](releases.md). As of 2026-11-10 07:10Z (after #86).

## Services

- **App, MCP, admission, daily check:** `milton-app-flat-1e6d859`, `milton-mcp-flat-1e6d859`,
  `milton-admit-00008-lxx` and job `milton-e2e-daily`, all on image
  `sha256:1be0d2c524a5e5d0f7eb45da8ee9830e0c5b684c5d702792ba5c702de99d8d8d` (#85, `1e6d859`).
  Rollback, code only, all four together: `milton-app-rank-898f9ad`,
  `milton-mcp-rank-898f9ad`, `milton-admit-00007-rpn` and the job to image
  `sha256:093ace98ef05c1c13b7ea45af5aef9baf06e505c12e5556ed6329a598e5e736c` (#83, `898f9ad`).
- **Auth and its jobs:** `milton-auth-00020-k77`, `milton-auth-mail` and `milton-auth-maint`
  on image `sha256:11946548b6e3fc563c11b8e6d2933566a7f90a83d83156e2e4ccf8a0d1d9bf56` (#86,
  `8faa274`; Cloud Run shows the amd64 manifest digest, not this index digest). Rollback,
  code only, service and both jobs together: `milton-auth-00019-p4f` and image
  `sha256:dc55298e668a85c2d126870435264a1aef883afa903fc43bf779fe2e5fdc7165` (#77).
- **Site:** Vercel production deployment of `8faa274`.
- **Secrets:** app `milton-app-env` 4 / `milton-app-key` 2, MCP `milton-mcp-env` 4 /
  `milton-mcp-key` 2 and auth `milton-auth-env` 2 / `milton-auth-key` 1, as at the 2026-11-07
  cutover (no release since recorded a change; confirm before the next one); admission
  `milton-admit-env` 2 / `milton-admit-key` 2 (admit.service.json); `milton-e2e-daily`
  `milton-e2e-account` 1; `milton-auth-maint` `milton-auth-owner-url` 1.
- **Schedules and settings:** `milton-e2e-daily` at `7 2,14 * * *` UTC; Turnstile off (no
  keys); every service keeps one warm instance.

## The floor

- **App, MCP and admission never roll back below #76** (`milton-*-memos-bdac60f`,
  `milton-admit-00005-vp2`, image `sha256:b29524412dfee440627cc2f7487317fadae4e64b597bf89fec2ce8494c4c8060`):
  0013 (#78) dropped the tables older code reads. The only way below is restoring snapshot
  `snap-mute-water-b85o19c9`, which loses every write since.
- **Auth never rolls back below `milton-auth-00018-heq`** (#63): older auth calls the app's
  admission routes, which no revision at or above the app's floor serves.

## Schema heads

- Drizzle: `0014_drop_source_hash`, journal 15 entries (`0000_baseline` to 0014), applied
  2026-11-10.
- Native auth ledger: 001–008 (`008-deletion-links`, 2026-11-08).
- Owner files: `000-app-owner.sql` through `015-drop-guide-roles.sql`, all applied (015 on
  2026-11-10). `005-app-roles.sql` is never rerun.

## Snapshots to keep

- `snap-mute-water-b85o19c9` (`before-0013-drop-old-writing-pr78`): the only copy of the old
  writing tables, old receipts and guide roles. No expiry; kept until Peter says.
- `snap-lingering-rice-b8pg8kxw` (`before-0014-drop-source-hash-pr82`): the only copy of
  `save_requests.source_hash`.
- `snap-fancy-hat-b8j5ls14` (pre-cutover, 2026-11-07): excluded from recovery; restoring it
  is Peter's decision ([migrations](migrations.md#database-recovery)).
- Other manual pre-migration snapshots are kept until deleted; scheduled ones last 14 days.

## Open, not yet observed

- A reply to a real verification email reaching support (#75).
- A refused sign-up, sign-in or reset form end to end (#77).
- Whether a Checkout session opened before a deletion can still complete (#71; Peter's
  sandbox test, with the billing test).
- The mail pause metric's `seconds>900` comparison, until the first throttle.
