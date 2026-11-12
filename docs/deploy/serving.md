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
[releases](releases.md). As of 2026-11-12 02:18Z (after #109).

## Services

- **App, MCP, admission, daily check:** `milton-app-evidence-4668940`,
  `milton-mcp-evidence-4668940`, `milton-admit-00012-4km` and job `milton-e2e-daily`, all on
  image `sha256:eb45b83fd3509cd751be9622c88c00b0845fe2bf893d0a714f8590024f6b5744` (#109 with
  #107, `4668940`; Cloud Run shows the amd64 manifest digest `sha256:3b1f4ffd…`, not this
  index digest). Rollback, code only, all four together: `milton-app-own-82ef571`,
  `milton-mcp-own-82ef571`, `milton-admit-00011-jd9` and the job to image
  `sha256:e70e8e769eaaa5032bbe5a0341e4253017a4badaadaaf55685ed1b108df02cf8` (#108, `82ef571`).
  That code runs on the schema after 0015 and 016 (additive; it never names the new table or
  columns); on it a kept request and the memo page's change list are not shown, and the
  tweak score is not served. An emptied cover sheet stays readable on it.
- **Auth and its jobs:** `milton-auth-00021-2gc`, `milton-auth-mail` and `milton-auth-maint`
  on image `sha256:d394050c2687a6872655b6075d1e3de9f4c2defe4a05353721dd0ea31ec0a832` (#102,
  `735937f`; Cloud Run shows the amd64 manifest digest, not this index digest). Rollback,
  code only, service and both jobs together: `milton-auth-00020-k77` and image
  `sha256:11946548b6e3fc563c11b8e6d2933566a7f90a83d83156e2e4ccf8a0d1d9bf56` (#86).
- **Site:** Vercel production deployment of `4668940` (#109's privacy and terms, dated
  November 11, 2026).
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
  0013 (#78) dropped the tables older code reads, and its snapshot `snap-mute-water-b85o19c9`
  is deleted (Peter, 2026-11-10). Going below means restoring the newest snapshot with the
  old tables, `snap-holy-cloud-b8jmn8q3` (before 0012, 2026-11-09 22:24:49Z), which loses
  every write since, every memo included. Until 2026-11-11 04:09Z, Neon's 24-hour
  point-in-time history also reaches a moment before owner file 015 (04:09:22Z) and 0013,
  losing less.
- **Auth never rolls back below `milton-auth-00018-heq`** (#63): older auth calls the app's
  admission routes, which no revision at or above the app's floor serves.

## Schema heads

- Drizzle: `0015_memo_evidence`, journal 16 entries (`0000_baseline` to 0015), applied
  2026-11-12.
- Native auth ledger: 001–008 (`008-deletion-links`, 2026-11-08).
- Owner files: `000-app-owner.sql` through `016-memo-evidence-roles.sql`, all applied (016 on
  2026-11-12; rerun it after any rerun of 014). `005-app-roles.sql` is never rerun.

## Snapshots to keep

- `snap-holy-cloud-b8jmn8q3` (`before-0012-memos-pr76`): the newest copy of the old writing
  tables, old receipts and guide roles since `snap-mute-water-b85o19c9` was deleted, and so
  the restore point for going below [the floor](#the-floor). The scheduled snapshots that
  still hold them are older and expire by 2026-11-23; older manual ones lose more.
- `snap-lingering-rice-b8pg8kxw` (`before-0014-drop-source-hash-pr82`): the only copy of
  `save_requests.source_hash`.
- `snap-dry-block-b8hc81mt` (`before-0015-memo-evidence-pr109`, 2026-11-12 02:16:00Z): the
  schema before 0015 (additive, so the code rollback does not need it).
- `snap-fancy-hat-b8j5ls14` (pre-cutover, 2026-11-07): excluded from recovery; restoring it
  is Peter's decision ([migrations](migrations.md#database-recovery)).
- Other manual pre-migration snapshots are kept until deleted; scheduled ones last 14 days.

## Open, not yet observed

- A reply to a real verification email reaching support (#75).
- A refused sign-up, sign-in or reset form end to end (#77).
- Whether a Checkout session opened before a deletion can still complete (#71; Peter's
  sandbox test, with the billing test).
- The mail pause metric's `seconds>900` comparison, until the first throttle.
