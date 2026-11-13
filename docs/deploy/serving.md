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
[releases](releases.md). As of 2026-11-13 20:51Z (after #133 and #135).

## Services

- **App, MCP, admission, daily check:** `milton-app-reqline-7c00dc2`,
  `milton-mcp-reqline-7c00dc2`, `milton-admit-00017-dgn` and job `milton-e2e-daily`, all on
  image `sha256:5b7d4af77607860bc9cc7c6531d06306e624525283e2574e9cc474f688854791` (#133 and
  #135, `7c00dc2`: code's change list splits a cut and an addition that only touch, and the
  request rule; Cloud Run shows the amd64 manifest digest `sha256:b4c7979b…`, not this index
  digest). Rollback, code only, all four together: `milton-app-titles-a4e50a7`,
  `milton-mcp-titles-a4e50a7`, `milton-admit-00016-mf8` and the job to image
  `sha256:370e09df97c17ed790da17ededef9a6563e6c1e6ca8d988e478f72ee04b19037` (#124,
  `a4e50a7`). Memos saved after this release keep their stored changes and requests on
  rollback. Below that, `milton-*-tweaks-bab745d`, `milton-admit-00015-cwp` and image
  `sha256:cbc0e41cd1aad421937dbb9d45a72ad7dbeefb725db6e866e8243973ead11d04` (#121). Below that, the
  degraded rollback to #116 in [releases](releases.md#rolling-back-memos-and-tweaks-only):
  MCP and the job to `milton-mcp-oneline-6b7a679` and image
  `sha256:b59a4123b1f7f8b2baf9099b8fbf0b180342ce1cb71b10a0751788a7a8ddfbe6`, drain, rerun
  the affected-accounts query, then `milton-app-oneline-6b7a679` and `milton-admit-00014-v25`;
  good until the later cleanup, fix forward after.
- **Auth and its jobs:** `milton-auth-00034-dos`, `milton-auth-mail` and `milton-auth-maint`
  on image `sha256:35ffb003f6a5918ced32bffd039fad9ff9315e108aa98b84c243d601efe2afbd` (#121,
  `bab745d`, built from `apps/auth/Dockerfile` with both base images pinned by digest; amd64
  `sha256:c0ca2a64…`). Rollback, code only, service and both jobs together:
  `milton-auth-00021-2gc` and image
  `sha256:d394050c2687a6872655b6075d1e3de9f4c2defe4a05353721dd0ea31ec0a832` (#102).
- **Site:** Vercel production deployment of `7c00dc2`, published from main at #135's merge
  (the privacy page dated November 13, 2026, with the request wording; the homepage's
  onboarding row from #134). Rollback: Vercel's previous production deployment.
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

- Drizzle: `0016_loosen_checks`, journal 17 entries (`0000_baseline` to 0016), applied
  2026-11-12 19:40Z. The code serving now predates it and satisfies its looser checks.
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
- `snap-curly-water-b8d140f8` (`before-0016-loosen-checks-pr119`, 2026-11-12 19:39:21Z):
  the schema before 0016 (it only loosens checks, so no code rollback needs it).
- `snap-fancy-hat-b8j5ls14` (pre-cutover, 2026-11-07): excluded from recovery; restoring it
  is Peter's decision ([migrations](migrations.md#database-recovery)).
- Other manual pre-migration snapshots are kept until deleted; scheduled ones last 14 days.

## Open, not yet observed

- A reply to a real verification email reaching support (#75).
- A refused sign-up, sign-in or reset form end to end (#77).
- Whether a Checkout session opened before a deletion can still complete (#71; Peter's
  sandbox test, with the billing test).
- The mail pause metric's `seconds>900` comparison, until the first throttle.
