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
[releases](releases.md). As of 2026-11-19 07:56Z (after #167, with 0017 from #168).

## Services

- **App, MCP, admission, daily check:** `milton-app-diffgate-c018c31`,
  `milton-mcp-diffgate-c018c31`, `milton-admit-00023-m57` and job `milton-e2e-daily`, all on
  image `sha256:ed44f5c53c00add5328db4a8da06ca4199355242b219d72aaf9b8a92fee8f45b` (#167,
  `c018c31`: a save works out its change list only after the access gate admits it; Cloud
  Run shows the amd64 manifest digest `sha256:532db919…`, not this index digest). Rollback,
  code only, all four together: `milton-app-billing-9b926b2`, `milton-mcp-billing-9b926b2`,
  `milton-admit-00022-fc4` and the job to image
  `sha256:56404eec54213d8ce50e024f3ec2cde1fc2a9f1d4ac3511ea354cd02f72ab148` (#165,
  `9b926b2`), with no schema step: it satisfies 0017's check, since save.ts already refused
  every request the check refuses. Below that, `milton-*-firstline-f9c7b32`,
  `milton-admit-00021-46m` and image
  `sha256:cc7eb9ca54bb546430100ad883bc2c60231a320f55ceed19d107ed350139030f` (#156 and
  #157). Below that, `milton-*-grants-62b3101`, `milton-admit-00020-b46` and image
  `sha256:d71dbee5971b08ef93f0024d1075e572fa01ad7349635db2231f76d49aa3e365` (#152,
  `62b3101`). Below that,
  `milton-*-replaces-87ed9dc`, `milton-admit-00019-25l` and image
  `sha256:14e0b206ae7f8a24fab267b71bd75a41dea172101bd9b64d1d95e73862eec51c` (#148), which
  runs on native 009 and lists each approval as its own row. Below that, `milton-*-posted-15d93cf`, `milton-admit-00018-p7z` and image
  `sha256:a5d65650f52539a1dc1f39a3dcf4ee509a64159f845c4af7aa0fe00029636e99` (#139): AIs
  holding `create_memo`'s `replaces` get an invalid-input refusal on a replace until they
  reconnect. Below that, `milton-*-reqline-7c00dc2`,
  `milton-admit-00017-dgn` and image
  `sha256:5b7d4af77607860bc9cc7c6531d06306e624525283e2574e9cc474f688854791` (#133 and #135).
  Below that,
  `milton-*-titles-a4e50a7`, `milton-admit-00016-mf8` and image
  `sha256:370e09df97c17ed790da17ededef9a6563e6c1e6ca8d988e478f72ee04b19037` (#124). Below that, `milton-*-tweaks-bab745d`, `milton-admit-00015-cwp` and image
  `sha256:cbc0e41cd1aad421937dbb9d45a72ad7dbeefb725db6e866e8243973ead11d04` (#121). Below that, the
  degraded rollback to #116 in [releases](releases.md#rolling-back-memos-and-tweaks-only):
  MCP and the job to `milton-mcp-oneline-6b7a679` and image
  `sha256:b59a4123b1f7f8b2baf9099b8fbf0b180342ce1cb71b10a0751788a7a8ddfbe6`, drain, rerun
  the affected-accounts query, then `milton-app-oneline-6b7a679` and `milton-admit-00014-v25`;
  good until the later cleanup, fix forward after.
- **Auth and its jobs:** `milton-auth-codes-8522391`, `milton-auth-mail` and
  `milton-auth-maint` on image
  `sha256:f1dca8ee9695b0ae97def340f58ed7b0f393dd8ea9cd9eda4217203e2524ca41` (#161,
  `8522391`: owner-script refusal codes and the private output directory; built from `apps/auth/Dockerfile` with both base
  images pinned by digest; amd64 `sha256:5739f092…`). Rollback, code only, service and both
  jobs together: `milton-auth-00034-dos` and image
  `sha256:35ffb003f6a5918ced32bffd039fad9ff9315e108aa98b84c243d601efe2afbd` (#121), with no
  schema step. Below that, `milton-auth-00021-2gc` and image
  `sha256:d394050c2687a6872655b6075d1e3de9f4c2defe4a05353721dd0ea31ec0a832` (#102).
- **Site:** Vercel production deployment of main at `9b926b2` (#165's merge: the pricing
  card's billing line and the FAQ's "Who do I ask about a charge?"; `/lab` since #163).
  Rollback: Vercel's previous production deployment.
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

- Drizzle: `0017_request_rules`, journal 18 entries (`0000_baseline` to 0017), applied
  2026-11-19 00:22Z (#168): the check `memos_request_typed` holds the typed request's
  12-line and pasted-mail rules, never stricter than save.ts. Every serving and rollback
  revision above already refuses those requests before the database.
- Native auth ledger: 001–009 (`009-approvals-per-client`, 2026-11-18 18:53:54Z: up to 10
  active approvals per account and AI client). Its rollback is the pre-migration snapshot
  below; no code needs 008's rule.
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
- `snap-round-shape-b8ndkdn2` (`before-009-approvals-per-client-pr152`, 2026-11-18
  18:53:19Z): the schema before native 009 (one function changed, no data).
- `snap-icy-violet-b8pu7936` (`before-0017-request-rules-pr168`, 2026-11-19 00:22:00Z):
  the schema before 0017 (one added check, no data changed, so no code rollback needs it).
- `snap-fancy-hat-b8j5ls14` (pre-cutover, 2026-11-07): excluded from recovery; restoring it
  is Peter's decision ([migrations](migrations.md#database-recovery)).
- Other manual pre-migration snapshots are kept until deleted; scheduled ones last 14 days.

## Open, not yet observed

- A reply to a real verification email reaching support (#75).
- A refused sign-up, sign-in or reset form end to end (#77).
- Whether a Checkout session opened before a deletion can still complete (#71; Peter's
  sandbox test, with the billing test).
- The mail pause metric's `seconds>900` comparison, until the first throttle.
