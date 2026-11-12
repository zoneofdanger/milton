---
name: history
description: Append-only record of Milton's production releases and applied one-time migrations, newest first, with revisions and snapshot names
type: reference
covers:
  - server/deploy/**
---

# Release history

Append-only, newest first. Each release adds its record at the top, and no entry is
rewritten. Rollback targets and floors in an entry were true when it was written; the
current ones are in [serving](deploy/serving.md), and the procedure is in
[releases](deploy/releases.md) and [migrations](deploy/migrations.md).

The entries up to 2026-11-10 came from the hosting runbook (`server/deploy/README.md`) word
for word, under dated headings, with three exceptions: links point where their targets now
live (removed sections by permalink to the runbook before the split); a private file path in
the #78 record is redacted; and the auth mail entry leaves out the Turnstile switch-on, a
pending procedure now in [releases](deploy/releases.md#turnstile-separate-go-from-peter-at-release).

Earlier records are in git history: the last runbook holding them is at commit 492b96a
(`git show 492b96a:server/deploy/README.md`), and the runbook's later versions are in
`git log -p server/deploy/README.md` until 2026-11-10, when this file began.

## 2026-11-12: memos and tweaks only (PR #121)

- **#121 (Peter's "ship it", typed in milton-overlord's pane wH:p1F on 2026-11-12 at about
  21:21 UTC, answering milton-overlord's "Nothing touches production until you say "ship
  121". milton-duo is preparing its checks in the meantime." right after the release plan,
  order, timing and rollback limits; relayed verbatim by milton-overlord; the redesign
  approved in the build brief's addenda; built by milton-rules; the rule ruled by Codex
  gpt-6-astra UNSOUND twice, then SOUND WITH CHANGES; the code FAIL at `a0fb191`,
  `2ce0592` and `b44022a`, round 3 at `f326caf` checked by milton-duo; milton-designer
  approved the UI at `a0fb191` and the demo at `d4cbae7` on the PR; milton-qa's real-client
  run E4 at `a0fb191` and its stale-client rerun at `f326caf` met the bar), `bab745d`:**
  memos and tweaks only. Two tools (`get_report`, `create_memo`); `get_cover_sheet` refused
  at dispatch. No cover sheet, no AI-written notes, no rounds, no tweak score; tweaks are
  the changes code works out from first draft to final. Request ids are 1 to 64 of
  `[A-Za-z0-9._:-]`. Removed fields and bidi controls refused with rollout-boundary
  guidance after a receipt lookup. Reports write nothing and carry the account's memo
  count. Legacy rows are kept, unread except in TPS.md and historical replays (labelled
  `replayed`). The auth consent screen and the site's copy follow; `/tools` and `/support`
  are new; the homepage's "with Milton" drafts were regenerated as served.
  - **Schema:** none in the release; 0016 (#119) went first. No grant changed.
  - **Preflight**, read-only: the e2e account resolved to one marked test account (issuer
    `https://auth.meetmilton.com/api/auth`), 0 cover sheets, tweaks and citations, baseline
    60 `served_reports` and 49 `save_requests`; no e2e execution active or pending.
  - **Order**, by the runbook's "When MCP's tools change": all images staged first; admit
    `milton-admit-00015-cwp` and app `milton-app-tweaks-bab745d` at 21:24:40Z; the old app
    drained (no request after 21:25:40Z); MCP `milton-mcp-tweaks-bab745d` at 21:26:32Z; the
    old MCP drained (no request after 21:29:35Z, no busy runtime connection); the account
    rechecked; `milton-e2e-daily` at 21:30:27Z, then `milton-e2e-daily-52x86` passed, leaving
    `served_reports` at 60 and `save_requests` at 52 (its 3 receipts), still no cover sheet,
    note or citation; auth `milton-auth-00034-dos` with `milton-auth-mail` and
    `milton-auth-maint` at 21:31:25Z; main pushed at 21:31:40Z and the site published.
  - **Images:** server `sha256:cbc0e41cd1aad421937dbb9d45a72ad7dbeefb725db6e866e8243973ead11d04`
    (amd64 `sha256:aaf0770b…`); auth `sha256:35ffb003f6a5918ced32bffd039fad9ff9315e108aa98b84c243d601efe2afbd`
    (amd64 `sha256:c0ca2a64…`), from the repo's `apps/auth/Dockerfile`, base images pinned
    (bun 1.4.4 `sha256:1d22548f…`, node 26.13.0-bookworm-slim `sha256:add5c17c…`).
  - **Live:** app and MCP `/health`, auth `/api/auth/ok`, app home, `/login` and `/signup`
    200; MCP 401 unauthenticated and discovery 200; UserInfo 401 on a junk token; admit 403
    without a token; forms probe PASS; site `/`, `/privacy`, `/terms`, `/tools` and
    `/support` 200. Gate at 21:41Z: clean; no request reached an older app, MCP, admission or auth revision after 21:33Z; no error, `store_unavailable` or `permission denied` lines since 21:23Z.
  - **Checks** on the local merge `bab745d` (tree as `f326caf`; main had not moved): types,
    142 server and 33 auth tests, format, agent-docs and the migration guard 0; PR CI green.
  - **Not observed:** a real person's save or report in the new shape.
  - **Rollback**, degraded: MCP and the job to `milton-mcp-oneline-6b7a679` and image
    `sha256:b59a4123…`, drain, rerun the affected-accounts query, then
    `milton-app-oneline-6b7a679` and `milton-admit-00014-v25`; auth to
    `milton-auth-00021-2gc` with both jobs; the site to `6b7a679`. Limits
    ([releases](deploy/releases.md#rolling-back-memos-and-tweaks-only)): the TPS page can
    return 503 for accounts the query lists, and new-shape saves fail until AIs refresh.

## 2026-11-12: Drizzle 0016 loosens the rounds and request id checks (PR #119)

- **#119 (Peter's "ship 119", answering milton-overlord's "say "ship 119" and milton-duo
  applies it once the three fixes pass its recheck. You can give the go now, and it won't
  run before that recheck.", typed in milton-overlord's pane wH:p1F on 2026-11-12 and
  relayed verbatim by milton-overlord; built by milton-rules; independent review Codex
  gpt-6-astra: PASS WITH CHANGES at `06b3759`, three fixes at `e18ea8b` rechecked by
  milton-duo, the new two-connection lock and timeout group passing in CI), `d0a5c6b`:**
  the schema half of "expand now, contract later" for the memos-and-tweaks redesign.
  `memos_first_draft` lets a kept or missing first draft go without rounds; `memos_request_id`
  and `save_request_id` take 1 to 64 of `[A-Za-z0-9._:-]` instead of exactly 36 characters.
  No row rewritten, no grant changed, nothing touching `neon_auth`, no code release.
  - **Before:** snapshot `snap-curly-water-b8d140f8` (`before-0016-loosen-checks-pr119`) at
    19:39:21Z, plus a private `pg_dump` checkpoint. 0 memos and 50 `save_requests`
    (49,152 and 131,072 bytes). Read-only preflight: 0 and 0 request ids outside the new
    alphabet. Journal 16, latest `0015`'s timestamp, against 17 in the checkout: only
    0016 pending.
  - **Run:** `db:migrate` from `e18ea8b` with traffic open, 19:40:19–19:40:22Z (2.6 s
    including connection). After: journal 17; the three CHECK definitions as written;
    `check-runtime-role` ok for app and MCP. Rehearsed lock-held time was 3 ms empty, 16 ms
    at 1,000 rows and about 0.7 s at 50,000.
  - **Rollback:** none needed for the serving code, which satisfies the looser checks. The
    snapshot is the schema's restore point.
  - The private `pg_dump` from #109's migration was deleted on Peter's "do it"
    (2026-11-12), its snapshot `snap-dry-block-b8hc81mt` still kept.

## 2026-11-12: one-line fields turn invisible line separators into a space (PR #116)

- **#116 (Peter's "go" to building it, answering milton-overlord's plan "invisible line
  separators become a single space. Ordinary line breaks and control characters are still
  refused, with no change from today. No database change.", and "ship 116.", answering
  "The line-break fix (#116) has passed its independent review, and CI is green. … Say
  "ship 116" to release it.", both typed in milton-overlord's pane wH:p1F on 2026-11-12 and
  relayed verbatim by milton-overlord; built by a temporary builder; independent review
  Codex gpt-6-astra: FAIL at `383fcb0` on two findings, fixed at `ea86c27` and rechecked by
  milton-duo), `6b7a679`:** each run of U+2028 and U+2029 in a one-line field becomes one
  space before the trim and before the request hash; a cover sheet remove matches by the
  same mapping; the cover sheet and `get_cover_sheet` show stored separators as a space;
  every tool result escapes U+2028 and U+2029 in its JSON. `create_memo`'s description now
  promises only final and first_draft unchanged. Accepted rollout limit, with no
  compatibility path: an identical retry, straddling the deploy, of a save whose one-line
  field held a separator gets `request_id_reused` ([saves](saves.md#receipts)).
  - **Schema:** none. **Site:** content unchanged.
  - **Image** `sha256:b59a4123b1f7f8b2baf9099b8fbf0b180342ce1cb71b10a0751788a7a8ddfbe6`
    (amd64 `sha256:d03dafd1…`): admit `milton-admit-00014-v25` at 18:15:45Z, app and MCP
    `milton-*-oneline-6b7a679` as tagged no-traffic revisions, traffic moved at 18:16:28Z,
    `milton-e2e-daily` at 18:16:30Z.
  - **Live:** app and MCP `/health` and auth `/api/auth/ok` 200, app home 200, MCP 401
    unauthenticated, admit 403 without a token, forms probe PASS, `milton-e2e-daily-ttc7t`
    passed. Gate at 18:26Z: clean; no request reached an older revision after 18:18:45Z; no error, `store_unavailable` or `permission denied` lines since 18:15Z.
  - **Checks** on `ea86c27`, whose tree `6b7a679` has (main had not moved): types, 137
    server tests, format and agent-docs 0; PR CI green.
  - **Not observed:** a real AI app sending or displaying a line separator.
  - **Rollback**, code only, all four together: `milton-*-changes-b1d2760`,
    `milton-admit-00013-c6k` and the daily job to image `sha256:9c451e73…`.

## 2026-11-12: what they changed, served under drafted examples (PR #114)

- **#114 (Peter's "Ship it", answering milton-overlord's plan "Write the rule first… Have it
  reviewed before any code is written. Build it, test it with real AIs, then release." and
  "Say "ship it" and I'll start a builder on that plan.", and "1", choosing to keep removed
  text with a guard line knowing "That lowers the risk but can't guarantee it.", both typed
  in milton-overlord's pane wH:p1F on 2026-11-11 and relayed verbatim by milton-overlord;
  built by milton-changes; independent review Codex gpt-6-astra: the rule UNSOUND at v1,
  SOUND WITH CHANGES at v2, the code PASS WITH CHANGES at `578aac8` and `3e0de3a` (its ask
  to build the unused switch's off branch overruled after Peter's "1"), the last test fixes
  at `f2afdcc` checked by milton-duo by rerunning the two mutations; milton-designer
  approved the memo-page line at `578aac8` (PR comment); milton-qa's real-client run E3 at
  `578aac8`: no planted instruction followed in 20 of 20 exposed conversations across
  Claude Code and Codex, 20 of 20 memos saved, one draft in 20 lost a fact the control kept,
  accepted by milton-overlord as borderline and reported to Peter), `b1d2760`:** under each
  served drafted example (kept first draft, itemized changes, steered; at most three), a
  report quotes up to three of code's own stored change rows, whole and JSON-encoded, the
  first two and the last, within 3,000 code points, with one guard line in the Examples
  intro. Its own commits quote finals at every line break (CRLF, CR, LF, VT, FF, NEL,
  U+2028, U+2029) and flatten header fields and tweak text, closing a way for memo text to
  start report lines. The memo page says when its changes may be served. Privacy, terms,
  FAQ and For agents say words you removed may reach your connected AIs.
  - **Schema:** none.
  - **Image** `sha256:9c451e73f93a6d1aa90bfd499239f03c40d4e812cf0604d0cb9e890230ec1f30`
    (amd64 `sha256:44fcf717…`): admit `milton-admit-00013-c6k` at 06:02:27Z, app and MCP
    `milton-*-changes-b1d2760` as tagged no-traffic revisions, traffic moved at 06:03:12Z,
    `milton-e2e-daily` at 06:03:15Z. Site: Vercel production deployment of `b1d2760`
    (privacy and terms live with "including words you removed").
  - **Live:** app and MCP `/health` and auth `/api/auth/ok` 200, app home 200, MCP 401
    unauthenticated, admit 403 without a token, forms probe PASS, `milton-e2e-daily-gk4r7`
    passed. Gate at 06:13Z: clean; no request reached an older revision after 06:05:30Z; no error, `store_unavailable` or `permission denied` lines since 06:02Z.
  - **Checks** on `f2afdcc`, whose tree `b1d2760` has (main had not moved): types, 135
    server tests, format and agent-docs 0; PR CI green.
  - **Not observed:** a real person's report carrying change lines; Safari and screen
    readers.
  - **Rollback**, code only, all four together: `milton-*-evidence-4668940`,
    `milton-admit-00012-4km` and the daily job to image `sha256:eb45b83f…`, with the site
    back to `4668940`.

## 2026-11-12: memo evidence without the quote link, and the tweak score (PRs #109, #107)

- **#109 with #107 (Peter's "ship 109 when it's ready", about 2:45 PM, and for the narrower
  scope "go with choice 3 for now", about 5:30 PM, choice 3 being "Leave that part out for
  now. Ship everything else, and come back to examples once you have real memos to test
  on.", both typed in milton-overlord's pane wH:p1F on 2026-11-11 and relayed verbatim by
  milton-overlord; built by milton-evidence; independent review Codex gpt-6-astra: three
  FAILs on the quote matcher and one UNSOUND on its rule, after which Peter dropped the
  quote link; FAIL on two findings at `c7d6df2`, fixed at `b00f168` and rechecked;
  milton-designer approved at `b00f168` (PR comment 6812383728); milton-qa's real-client
  run E2 met its bar at `c7d6df2`, 20 of 20 memos saved across Claude Code and Codex, valid
  for `b00f168`, whose fix touches neither the save path nor the tool), `4668940`:** the
  tweak score (#107, merged first as `d7260c6`); `create_memo` takes main's `memo.tweaks`
  again, more than three distinct refused; a memo keeps the person's typed request, which
  the TPS page can remove; the memo page lists code's own unlabelled changes (whole diff
  spots, cut at 300 characters, `too_large` at the diff's bounds). The AI's quotes,
  labels, served before-and-after examples and typed share are not in it; `memo_changes`'
  label, tweak and quote columns stay NULL.
  - **Schema.** Snapshot `snap-dry-block-b8hc81mt` (`before-0015-memo-evidence-pr109`) at
    02:16:00Z, plus a private `pg_dump` checkpoint. Before: journal 15, 0 memos, 0 tweaks, 0
    citations. Drizzle `0015_memo_evidence` with `db:migrate` 02:16:51–54Z (journal 16), owner
    file `016-memo-evidence-roles.sql` with `psql` at 02:16:56Z. Check: the three new columns
    and `memo_changes` present, `memo_changes_tweak` with `IS TRUE`, `memo_changes` granted
    SELECT/INSERT to MCP and SELECT to app, app UPDATE on `memos.request` and
    `tweaks.text_changed_at` added, the 26 earlier table grants unchanged;
    `check-runtime-role` ok for app and MCP. Rehearsed twice on throwaway Neon branches of
    production (0015 through the migrator, 016 twice; schema diff additive only), then
    deleted; 0015 and 016 are byte-identical to the second rehearsal. No floor change.
  - **Image** `sha256:eb45b83fd3509cd751be9622c88c00b0845fe2bf893d0a714f8590024f6b5744`
    (amd64 `sha256:3b1f4ffd…`): admit `milton-admit-00012-4km` at 02:17:45Z, app and MCP
    `milton-*-evidence-4668940` as tagged no-traffic revisions, traffic moved at 02:18:25Z,
    `milton-e2e-daily` at 02:18:27Z. Site: Vercel production deployment of `4668940`
    (privacy and terms dated November 11, 2026, live).
  - **Live:** app and MCP `/health` and auth `/api/auth/ok` 200, app home 200, MCP 401
    unauthenticated, admit 403 without a token, forms probe PASS, `milton-e2e-daily-lb4nz`
    passed and left 0 memos, 0 change rows and 0 tweaks. Gate at 02:28Z: clean; no request reached an older revision after 02:20:30Z; no error, `store_unavailable` or `permission denied` lines since 02:16Z.
  - **Checks** on `b00f168` merged with main `336f2ee` (the tree merged): types, 170 tests,
    format, agent-docs and the migration guard 0; PR CI green.
  - **Not observed:** a real person's save in the new shape; Safari and screen readers.
  - **Rollback**, code only, all four together: `milton-*-own-82ef571`,
    `milton-admit-00011-jd9` and the daily job to image `sha256:e70e8e76…`, on the new
    schema. Restoring the snapshot is not a code rollback (fix forward).

## 2026-11-11: served instructions reuse the person's own words (PR #108)

- **#108 (Peter's "ship 108", typed in milton-overlord's pane wH:p1F on 2026-11-11 after
  milton-overlord's "CI is green on #108, the own-words sentence, at head b120aa5 … It's
  ready to ship when you say "ship 108"."; relayed verbatim by milton-overlord; built by its
  temporary subagent; served copy only, so CI review), `82ef571`:** the read-write
  instructions gain one paragraph after "Before writing or editing…": when the person says
  what to write, reuse their phrases word for word where they fit, add only a greeting, a
  sign-off and connecting words, and don't expand. Read-only instructions unchanged; no
  schema change. The tests behind it are in
  [own-words-sentence-2026-11](research/own-words-sentence-2026-11.md). Server image
  `sha256:e70e8e769eaaa5032bbe5a0341e4253017a4badaadaaf55685ed1b108df02cf8` (amd64
  manifest `sha256:d14de938…`; bundle carries the sentence once): admit
  `milton-admit-00011-jd9` at 19:27:52Z (2026-11-11), app and MCP `milton-*-own-82ef571` as
  tagged no-traffic revisions, traffic moved at 19:28:48Z, `milton-e2e-daily` at
  19:28:52Z. Site: Vercel production deployment of `82ef571` (no site file changed). Live:
  app and MCP `/health` and auth `/api/auth/ok` 200, app home 200, MCP 401
  unauthenticated, admit 403 without a token, forms probe PASS, `milton-e2e-daily-gdvv8`
  passed. Gate at 19:39Z: clean; no request reached an older revision after 19:30:30Z; no error, `store_unavailable` or `permission denied` lines since 19:27Z. Checks: PR CI green on `b120aa5`, which was based on main
  `6e92b0a`, so the merged tree is the same: types, 160 tests, format and agent-docs 0.
  Not observed: a real client (Claude Code, the ChatGPT app, the Claude app) following the
  sentence; connected AIs show it after they reconnect. Rollback, code only, all four
  together: `milton-*-cover-16341d6`, `milton-admit-00010-gn4` and the daily job to image
  `sha256:193135d2…`.

## 2026-11-11: the web cover sheet is read only (PR #103)

- **#103 (Peter's "Ship 103", typed in milton-overlord's pane wH:p1F on 2026-11-10 after
  milton-coversheet's report; the request his "in the web app, the cover sheet should not be
  editable, it is only generated/maintained via agent mcps", and "Let the AI remove the last
  line" over a web Clear button; relayed verbatim by milton-overlord; milton-coversheet;
  milton-designer approved, no findings), `16341d6`:** the TPS page shows the cover sheet
  read only and `POST /tps/cover-sheet` is gone; an AI's `cover_sheet.remove` of the last
  line empties it (the `cover_sheet_empty` refusal is removed). No schema change; the app
  role's unused INSERT grant on `cover_sheets` stays (not approved). Server image
  `sha256:193135d28e8fcc0707d840cffe7719edcee9f34697bb90b532ddf00321c730e8` (bundle without
  `cover_sheet_empty` or `/tps/cover-sheet`, with #100's mail step): admit
  `milton-admit-00010-gn4` at 07:31:18Z (2026-11-11), app and MCP
  `milton-*-cover-16341d6` as tagged no-traffic revisions, traffic moved at 07:32:03Z,
  `milton-e2e-daily` at 07:32:05Z. Site: /setup's copy live from Vercel's production
  deployment of `16341d6`. Live: app and MCP `/health` and auth `/api/auth/ok` 200, app
  home 200, MCP 401 unauthenticated, `POST /tps/cover-sheet` 404, forms probe PASS,
  `milton-e2e-daily-r9fhb` passed. Gate at 07:42Z: clean; no request reached an older
  revision after 07:33:30Z; no error, `store_unavailable` or `permission denied` lines
  since 07:30Z. Checks: PR CI green on `7fc8565`; on the tree
  merged with main (which had moved by #100 to #104): types, 160 tests, format and
  agent-docs 0. Not observed: a real AI emptying a cover sheet over MCP (the store test
  covers it); screen-reader speech. Rollback, code only, all four together:
  `milton-*-mail-cd2fa18`, `milton-admit-00009-c99` and the daily job to image
  `sha256:3630960a…`.

## 2026-11-11: consent preselects Read and write (PR #102)

- **#102 (Peter's request "can you make it so that the default oauth is read/write (right
  now it defaults to read)" and then "ship it when checks pass", both typed in
  milton-overlord's pane wH:p1F on 2026-11-10; relayed verbatim by milton-overlord;
  built by its temporary subagent), `735937f`:** the consent screen preselects Read and
  write when the AI's request includes `milton:write`, otherwise Read only; the person can
  still choose Read only, and connection keys keep their Read only default. Auth image
  `sha256:d394050c2687a6872655b6075d1e3de9f4c2defe4a05353721dd0ea31ec0a832` (built from
  the saved pinned auth build file, the private copy having been removed; its bundle holds
  `checked: !canWrite` and `checked: true`): `milton-auth-00021-2gc` deployed with no
  traffic, traffic moved by `update-traffic` at 06:51:42Z (2026-11-11), `milton-auth-mail`
  and `milton-auth-maint` by 06:51:47Z. Live: `/api/auth/ok`, `/login`, `/signup`,
  `/forgot-password` and `/reset-password` 200; `/consent` for a fictional client asking
  `openid milton:read milton:write` serves Read and write `checked`, and for
  `openid milton:read` serves Read only `checked` with no write choice; app and MCP
  `/health` 200, forms probe PASS, `milton-e2e-daily-bb2vj` passed. Gate at 07:02Z: clean;
  no auth request reached an older revision after 06:53Z; no errors from the services or
  either auth job, and every mail run since succeeded. Checks: PR CI green on `e5dc35c`
  (already on main); the builder's local auth integration 21/21. Not observed: a real AI
  client submitting the new form; Safari. Rollback, code only, service and both jobs
  together: `milton-auth-00020-k77` and image `sha256:11946548…`.

## 2026-11-10 to 2026-11-11: snapshot docs, homepage redesign, setup finds sent emails (PRs #97, #99, #100)

- **#100 (Peter's "Let’s ship it first", typed in milton-overlord's pane wH:p1F on
  2026-11-10, answering its summary of the test runbook; relayed verbatim by milton-overlord
  and milton-onboarding; it moves the PR's test-Gmail run to after the release),
  `cd2fa18`, TODO #13:** first setup's optional step where the person's own AI, with a mail
  tool already in the conversation and after a yes, searches their sent mail (last 90 days,
  at most about 30 read, up to five offered) and saves only the numbered emails they
  approve, exactly as shown; pasting stays the fallback. Served text and copy only: the
  setup script, the instructions' setup line, `create_memo`'s "(setup, …)", `SETUP_PROMPT`,
  the app's empty TPS page, and /setup and /privacy (dated November 10, 2026). No schema,
  tool or mail access in Milton. Server image
  `sha256:3630960abaf412deb2cab9625ba8a5eeb69f3092e94b083bc4f3d11d7a93325f` (amd64 manifest
  `sha256:0f967c97…`; the bundle holds the new script and not "setup never reads an inbox"):
  admit `milton-admit-00009-c99` at 02:15:41Z (2026-11-11), app and MCP
  `milton-*-mail-cd2fa18` as tagged no-traffic revisions, traffic moved at 02:16:43Z,
  `milton-e2e-daily` at 02:16:45Z. Live: app and MCP `/health` and auth `/api/auth/ok` 200,
  app home 200, MCP 401 unauthenticated, forms probe PASS, `milton-e2e-daily-82rk4` passed;
  /privacy serves "only the ones you approve reach Milton". Gate at 02:27Z: clean; no request
  reached an older revision after 02:18Z; no error, `store_unavailable` or
  `permission denied` lines from app, MCP, admit, auth or jobs since 02:15Z. Checks: PR CI
  green on `8d380f5` (already on `4fe0763`); merged tree types, 159 tests, format and
  agent-docs 0.
  Not yet observed: a real AI running the new step; that is the test-Gmail run (TODO #8).
  Rollback, code only, all four together: `milton-*-flat-1e6d859`, `milton-admit-00008-lxx`
  and the daily job to image `sha256:1be0d2c5…`; the site rolls back with a Vercel
  promotion.

- **#99 (Peter's "ship it" in milton-overlord's pane wH:p1F on 2026-11-10, after its preview
  at `19adbd0`; then "next, get rid of the FAQ section from the /about page", done in
  `10a1ccf`; milton-redesign, contains #98 from milton-tryit; milton-designer accepted),
  `4fe0763`:** the homepage redesign as a personnel file with the try-it box of fictional
  examples; /about back to main's. Site only, live from Vercel's production deployment of
  `4fe0763`: www.meetmilton.com/ and /about 200, the try-it data served, /about without
  questions. #98 shows merged, its commits being in #99.

- **#97, `abe594b`:** docs for the deleted #78 snapshot (entry below).

## 2026-11-08 to 2026-11-10: deletion fences Stripe, Stripe reads off the lock, guide pilot parked, deletion links, UserInfo binding, private admission service, session token drop, e2e fix, MCP next steps, guards (PRs #58–#66, #68–#92)

- **#78 snapshot deleted (Peter's "Delete now", in pane wH:p1F on 2026-11-10, answering
  milton-overlord's "Keep it or delete it now?"):** milton-overlord deleted
  `snap-mute-water-b85o19c9` (`before-0013-drop-old-writing-pr78`) with Neon's
  `delete_snapshot` and confirmed it gone with `list_snapshots`; the coordinator's listing at
  16:57Z agrees. The old tables, old receipts and guide roles now survive only in
  `snap-holy-cloud-b8jmn8q3` (before 0012, 2026-11-09 22:24:49Z) and older snapshots, and
  in Neon's 24-hour history until 2026-11-11 04:09Z.

- **#86 to #92, docs phase 2 (Peter's "land all", relayed verbatim by milton-overlord; auth
  release on his "release auth now", typed in milton-overlord's tab, the answer selected
  there at his request), landed by `8faa274`:** milton-docs' copy and docs PRs. #87, #90 and
  #91 (this runbook releases app and MCP by tagged revision, never the stale manifests) are
  docs only. #88's site copy (memos, not rules or samples, on home, pricing, terms, privacy,
  research and setup) is live from Vercel's production deployment of `8faa274`. #89: no
  blocking lead, and `CLAUDE.md` imports AGENTS.md. #92 drift guards (retired-words test,
  `packages/theme/facts.ts`); the served setup script's SHA-256 is unchanged
  (`d9084c9f…8ab3`), and its server copy ships with the next server image. #86's
  consent-screen copy: auth image
  `sha256:11946548b6e3fc563c11b8e6d2933566a7f90a83d83156e2e4ccf8a0d1d9bf56`,
  `milton-auth-00020-k77` at 06:06:53–07:10Z (2026-11-10, traffic moved by
  `update-traffic`), `milton-auth-mail` and `milton-auth-maint` by 06:07:15Z. Live:
  `/api/auth/ok`, `/login`, `/signup`, `/forgot-password` and `/reset-password` 200; the
  served bundle holds the new consent lines, and neither "Four tools" nor "exact text of
  every memo" remains; `milton-e2e-daily-82hf6` passed its sign-in. Gate at 06:18Z: clean; no auth request reached an older revision after 06:08Z; no errors from the revision or jobs. Checks: PR CI
  green on each head; merged tree types, 159 tests, format, site and server builds 0; main
  CI green on `8faa274`.

- **#85 (Peter's go, relayed verbatim by milton-overlord; milton-saves; Astra PASS, one
  should-fix, fixed), `1e6d859`, closes TODO #35:** `create_memo` reads a flattened memo
  (`memo` as the plain final text, its `context`, `new_kind` or `kind_id` beside it) as the
  nested one before validation and the request hash; an ambiguous or still-malformed one is
  refused with the nested shape. No migration. Server image
  `sha256:1be0d2c524a5e5d0f7eb45da8ee9830e0c5b684c5d702792ba5c702de99d8d8d`: admit
  `milton-admit-00008-lxx` at 05:43:33Z (2026-11-10), app and MCP `milton-*-flat-1e6d859` at
  05:43:49Z and 05:44:03Z, `milton-e2e-daily` at 05:44:05Z. Live: health 200 ×3, app home
  200, MCP 401 unauthenticated, forms probe PASS, `milton-e2e-daily-gh98t` passed; on the
  test account a flattened save was kept, its nested retry with the same `request_id`
  returned the same memo, a flattened save without context was refused with the shape, and
  the sheet was back to empty at the same version. Gate at 05:54Z: clean; no request reached an older revision after 05:45Z; no error lines. Checks: PR CI green on `3c09000`,
  merged tree types, 156 tests and format 0, main CI green on `1e6d859`.

- **#83 (Peter's go, relayed verbatim by milton-overlord; milton-ranking; Astra PASS, no
  findings), `898f9ad`:** reports rank purpose/audience overlap ahead of tier (kind, medium,
  overlap, tier, full-text rank, newest, id), so unrelated pasted setup writing no longer
  fills the first slots or pushes matches out of the 32 KiB budget. No migration. Server
  image `sha256:093ace98ef05c1c13b7ea45af5aef9baf06e505c12e5556ed6329a598e5e736c`: admit
  `milton-admit-00007-rpn` at 05:29:26Z (2026-11-10), app and MCP `milton-*-rank-898f9ad` at
  05:29:44Z and 05:29:59Z, `milton-e2e-daily` at 05:30:02Z. Live: health 200 ×3, app home
  200, MCP 401 unauthenticated, forms probe PASS, `milton-e2e-daily-v92hl` passed. Gate at 05:40Z: clean; no request reached an older revision after 05:31Z; no error lines.
  Checks: PR CI green on `9c67ff8`, merged tree types, 155 tests and format 0, main CI green
  on `898f9ad`.

- **#82 (Peter's go, relayed verbatim by milton-overlord under AGENTS.md `aba41ee`; Astra
  PASS, two runbook fixes), `7bc1194`, closes TODO #30:** Drizzle `0014_drop_source_hash`
  drops `save_requests.source_hash` and checks `input_hash` alone. Snapshot
  `snap-lingering-rice-b8pg8kxw` (`before-0014-drop-source-hash-pr82`) at 04:58:49Z
  (2026-11-10); 12 receipts, 1 with `source_hash`. Applied with `db:migrate` at
  04:58:57–58Z (journal 15). Checks: column gone, constraint
  `CHECK ((input_hash ~ '^[a-f0-9]{64}$'::text))`, 0 violating rows, 12 receipts;
  `check-runtime-role` ok for app and MCP; `milton-e2e-daily-vqt4z` passed; no error,
  `store_unavailable`, `check_violation` or `permission denied` lines. Gate at 05:09Z: clean; no error lines from app, MCP, admit, auth or jobs since 04:58Z. Checks: PR CI
  green on `7afccc3`, merged tree types, 154 tests, format and released-migration hashes 0,
  main CI green on `7bc1194`. No image release (no serving code names the column); rollback
  floor stays #76.

- **#78 (Peter's own go in the coordinator's tab, after milton-overlord relayed "Go on 78
  now"; Astra FAIL, two fixes, PASS), `aee00b6`:** the drop and wipe from #76. Export first:
  the two real accounts' old writing, verified against the database, in Peter's
  private storage (mode 600). All app, MCP and admit
  traffic on post-#76 revisions; snapshot `snap-mute-water-b85o19c9`
  (`before-0013-drop-old-writing-pr78`, no expiry, kept until Peter says) at 04:08:51Z
  (2026-11-10). Removed: receipts 109, cards 44, samples 34, guide accounts 0 before; 99
  old-store receipts deleted, 10 kept (9 memo-era saves, the known `compiler_input_limit`
  receipt). Owner file 015 with `psql` at 04:09:22Z; `pg_roles` and Neon's branch role list
  both without the two guide roles. Drizzle `0013_drop_old_writing` at 04:09:31–35Z (journal
  14). Checks: no dropped table left; functions `milton_save_request_guard`,
  `milton_user_id_guard`, `prune_usage_calls`; 0 old-store receipts; `check-runtime-role` ok
  for app and MCP; `milton-e2e-daily-bsc4q` passed; health 200; no error, `permission denied`
  or `store_unavailable` lines. Gate at 04:20Z: clean; no error lines from app, MCP, admit, auth or jobs since 04:09Z. Checks: PR CI green on `b3677c8`, merged tree types,
  153 tests, format and the released-migration hashes (50) 0, main CI green on `aee00b6`.
  No image release.

- **#79 and #80 (Peter's go, relayed verbatim by milton-overlord; one release), `c3ed021`:**
  #79 (Astra PASS, no findings): `create_memo` reads `memo.tweaks: []` and
  `memo.kind_id: null` as omitted, before the request hash. #80 (milton-25; Astra FAIL on a
  lost retention line, then a should-fix, both fixed; PASS): first setup asks for about five
  pasted pieces the person wrote and sent, says Milton keeps each as a memo, and comes back to
  that ask after a writing task brought first. No migration. Server image
  `sha256:27219d385d25ef7f51315400613d3c28ed62219a903df2b93ba6e29507461192`: admit
  `milton-admit-00006-gjl` at 03:26:40Z (2026-11-10), app and MCP `milton-*-setup-c3ed021` at
  03:26:54Z and 03:27:10Z, `milton-e2e-daily` at 03:27:13Z. Live: health 200 ×3, app home
  200, MCP 401 unauthenticated, forms probe PASS, `milton-e2e-daily-cfqss` passed; on the
  test account a save with `tweaks: []` and one with `kind_id: null` were both saved, then
  forgotten, the sheet back to empty at the same version; the site's setup page serves the new
  ask. Gate at 03:38Z: clean; no request reached an older revision after 03:28Z; no error lines. Checks: PR CI green on `d8f34de` and `26d0b8e` (the
  integration job's one teardown failure on `26d0b8e` passed on rerun), merged tree types,
  154 tests and format 0, main CI green on `c3ed021`.

- **#76 (Peter's go; milton-memos; Astra FAIL, four fixes, delta PASS), `bdac60f`:** memos
  and tweaks replace rules and samples, and the guide pilot is removed. Snapshot
  `snap-holy-cloud-b8jmn8q3` at 22:24:49Z. Drizzle `0012_memos` with `db:migrate` at
  22:24:59Z (journal 13), owner file 014 with `psql` at 22:25:11Z; check: the seven tables
  empty, grants as 014, `can_reword_memo` f on all 14 rows, `check-runtime-role` ok for app
  and MCP. Old tables kept (44 rule cards, 34 samples, all accounts) until the follow-up drop.
  Server image `sha256:b29524412dfee440627cc2f7487317fadae4e64b597bf89fec2ce8494c4c8060`
  (pinned build file without the removed `guide-worker.js` line): admit
  `milton-admit-00005-vp2` at 22:26:22Z, app and MCP `milton-*-memos-bdac60f` at 22:26:36Z
  and 22:26:53Z, `milton-e2e-daily` at 22:26:55Z. Live: health 200 ×3, app home 200, MCP 401
  unauthenticated, forms probe PASS, `milton-e2e-daily-gxtx8` passed every new step
  (footprint memos 0, kinds 1, reports 3), a real-account `get_cover_sheet` read the empty
  new sheet, no `permission denied` or `store_unavailable` in app, MCP or admit logs; the
  site serves the new privacy, terms and setup pages. Gate at 22:39Z: clean; no request reached an older revision after 22:28Z; no error lines. Checks: PR CI green
  on `208fae3`, main CI green on `bdac60f`. Open: Peter opens his TPS page; AIs reconnect;
  the other account's notice (drafted, Peter sends).

- **#77 (Peter's request and go), `77f7d10`:** passwords are 8–128 characters (was 15)
  with ten obvious ones added to the inline common list; a larger list or a breach API
  was declined as over-engineered. A refused sign-up, sign-in, reset or password change
  re-renders its own form with the message and what was typed (never the password), so
  a refused reset keeps its link. No migration. Auth image
  `sha256:dc55298e668a85c2d126870435264a1aef883afa903fc43bf779fe2e5fdc7165`:
  `milton-auth-00019-p4f` at 17:15:28Z (traffic moved by `update-traffic`), mail and
  maintenance jobs by 17:15:33Z. Live: health, `/api/auth/ok`, `/login`, `/signup`,
  `/forgot-password` and `/reset-password` 200; sign-up and reset show the 8–128 rule and
  `minlength="8"`; `milton-e2e-daily-kzqmn` passed. Gate at 17:25Z: clean; no auth
  request reached an older revision after 17:16Z; no errors from the revision or jobs.
  Checks: PR CI green on `2234657`. Not checked live: a refused form end to end.

- **#75 (Peter's go; milton-qa), `e616331`:** sign-in mail hardening: a DNS check skips
  domains that cannot take mail, a per-address cap of 3 per kind per hour, Reply-To
  `support@meetmilton.com`, JSON mail-job logs and the `milton-auth-mail` page policy.
  Turnstile stays off (no keys). No migration. Auth image
  `sha256:51a8d3e3d2bcf5a254779ae80e3bcd71c47806f14af73b24a9b693638fb6d05d`:
  `milton-auth-00018-hcv` at 10:20:10Z (traffic moved by `update-traffic`), then
  `milton-auth-mail` and `milton-auth-maint` by 10:20:15Z. First JSON `auth_mail_pass` at
  10:21:31Z; `monitoring.ts --apply` created `milton-auth-mail-problems`,
  `milton-auth-mail-long-pause` and the `milton-auth-mail` policy, and a second plan was 16
  unchanged. Live: health and `/api/auth/ok` 200, `/login`, `/signup` and
  `/forgot-password` 200, no warnings from the new revision or errors from either job.
  Gate at 10:30Z: clean; no auth request reached an older revision after 10:21Z. Checks: PR
  CI green on `ef4e84d`, main CI green on `e616331`. Not yet checked: a reply to a real
  verification email reaching support.

- **#74 (Peter's word change and go; milton-say-ai; milton-designer ACCEPT), `74f6153`:**
  "AI", not "assistant", in everything people and AIs read: site, privacy and terms (dated
  2026-11-09; the provider-terms wording kept on Peter's go), app pages, sign-in pages and
  MCP served text. Identifiers, routes and error codes unchanged. No migration. Server image
  `sha256:73b1ae07e9b527208593a04a08a2dfef8d8e95e5616d18bab29234c2ec90c2b4`: admit
  `milton-admit-00004-q7h` at 08:57:59Z (from [admit.service.json](../server/deploy/admit.service.json)), app
  and MCP `milton-*-sayai-74f6153` at 08:58:37Z and 08:58:51Z, and the daily job; auth image
  `sha256:b129db3db83d494014bd32c082c61d3b986b7cfcd200a13732e248611e5faa22`:
  `milton-auth-00017-swp` at 08:58:14Z (traffic moved by `update-traffic`), mail and
  maintenance jobs too (`AUTH_ADMISSION_URL` kept). Live: health 200 ×3, app home 200, MCP
  401 unauthenticated, admit 403 without a token, UserInfo 401 on a junk token, forms probe
  PASS, `milton-e2e-daily-9nzmk` passed with its sign-in admitted (204, 165 ms), privacy
  shows the new date and wording. Gate at 09:09Z: clean; no request reached an older
  revision after 09:00Z. Checks: PR CI green on `2862bb9`, main CI green on `74f6153`.
  Connected AIs may keep showing the old tool wording until they reconnect.

- **e2e twice a day (Peter's go, 2026-11-09 07:50Z):** scheduler `milton-e2e-daily` moved
  to `7 2,14 * * *` UTC, and its policy gained "no execution for 13 h" (alignment 1 h, so
  14 h in all, inside the one-day absence limit). One manual run, `milton-e2e-daily-9lgrq`,
  passed at 07:53Z so the new condition did not fire on the gap since 11-08 22:39Z. Plan
  after apply: 13 unchanged; no open incident.
- **DMARC (Peter's go, 2026-11-09):** Cloudflare DMARC Management enabled for
  meetmilton.com; it wrote `_dmarc.meetmilton.com TXT "v=DMARC1; p=none;
rua=mailto:<prefix>@dmarc-reports.cloudflare.net"` (reports in the Cloudflare dashboard;
  `notifications.` inherits it). Move to `p=quarantine` only after about two weeks of
  clean reports and once nothing else sends as @meetmilton.com.
- **e2e alert (2026-11-09 07:25Z):** `milton-e2e-daily` applied with its failure condition
  only (≥ 1 failed execution in 24 h). The API refused the 26 h no-execution condition
  ("Durations longer than 23h30m are not supported"), and a metric-absence condition looks
  back at most a day in all (alignment period plus duration), so a missed daily run does
  not page yet; open decision under Alerts. `monitoring.ts` and its test now accept a
  missing `pending/` folder. Plan after apply: 13 unchanged; no open incident.
- **#72 (Peter's wording and go), `02f8138`:** the privacy page's plainer account-deletion
  paragraph (shared registrations stay when another account also approved them; the
  fingerprint covers deleted and erased ones), live on www.meetmilton.com. Text only.
- **#71 (Peter's go; milton-qa, three Astra rounds; closes TODO #32), `778a1a1`:** once a
  deletion has begun, checkout and enrolment link no Stripe customer and open no payable
  session, the erase step ends any customer still linked, and native sign-in, consent and
  social-link refuse with a final 403 `account_deleting` (admit answers 410). No migration,
  no settings change. Admit `milton-admit-00003-rmr` at 22:37:07Z (from
  [admit.service.json](../server/deploy/admit.service.json)) and app `milton-app-race-778a1a1` at 22:37:32Z,
  image `sha256:f5f29d47496807529aa31f5ddf2b0cd2c32559e5b86e439c4d4dec1ea9774f79` (the daily
  job too); auth `milton-auth-00016-q4c` at 22:38:34Z, image
  `sha256:58eaa4bc04ab1c4c15924abea541303ada28142e794924f3d1cb538af925a262` (mail and
  maintenance jobs too; `AUTH_ADMISSION_URL` kept). ⚠ `gcloud run deploy milton-auth` created
  the revision but left traffic on the tagged `00020-hef` (traffic names a revision, not
  latest), and Cloud Run records the image by its amd64 manifest digest (`099a1569…`), not the
  index digest: after an auth deploy, check the serving revision and move traffic with
  `update-traffic`. No request reached an older app, admit or auth revision after 22:39:40Z.
  Live: health 200 ×3, app home 200, MCP 401 unauthenticated, admit 403 without a token,
  UserInfo 401 on a junk token, forms probe PASS, an e2e sign-in admitted (204, 165 ms;
  `milton-e2e-daily-hd52d`), an MCP read. Checks: PR CI green on `102dd48` (same tree), main
  CI green on `02f8138`. Untested at Stripe: whether a Checkout session opened before deletion
  can still complete on the deleted customer (Peter's sandbox test, with the billing test).
  Gate at 22:49Z (from 22:37Z): clean; the maintenance job ran on the new image at 22:45Z and
  succeeded.
- **#70 (Peter's go; milton-perf, milton-qa PASS; supersedes #67), `7ffc5cf`:** checkout's
  live read and the webhook read Stripe with no transaction open and write by
  compare-and-set on `trial_accounts.stripe_revision` (see
  [its section](#2026-11-08-stripe-reads-off-the-row-lock-drizzle-0011-pr-70)).
  Snapshot `snap-damp-water-b8kiylpo` at 22:06:38Z; `0011_stripe_revision` at 22:06:47Z
  (journal 12 entries; `bigint NOT NULL DEFAULT 0`). With no billing or admission request in
  the previous 2 minutes, app `milton-app-srl-7ffc5cf` took 100% at 22:07:34Z and
  `milton-admit-00002-ws6` (from [admit.service.json](../server/deploy/admit.service.json); invoker still only
  `milton-auth@`, min 1) at 22:07:45Z, image
  `sha256:d866739c63b0856fd8c7ecbbd58cdf7aa0b9288bd9e06f0e15be339db41b13a3` (the daily job
  too); MCP stays on `milton-mcp-park-f735701` (its only change is an error code met only in
  checkout). No request reached an older app or admit revision after 22:07:50Z. Resync:
  dry run 2 customers, `--apply` reconciled 2, failed 0, exit 0 (both trialing, revision 1).
  Live: health 200 ×3, app home 200, forms probe PASS, admit 403 without a token, an e2e
  sign-in passed and admitted (204, 150 ms; `milton-e2e-daily-nndz9`). Checks on the merge
  (`0558765`, same tree): CI green, its integration run applying 0011. Gate at 22:18Z (from 22:06Z):
  clean.
- **#66 (Peter's go; milton-perf, milton-qa PASS), `f735701`:** the parked guide pilot is off
  every read unless `MILTON_GUIDES=on` (unset in both payloads and services), and Drizzle 0010
  drops the sample-version trigger. Step 1: app/MCP `milton-*-park-f735701` at 21:19:23Z
  (image `sha256:7318c5c418d9f78a723b28a7a4c0d2f9af57ed0db022c7bf539b45836923eaa8`; the daily
  job too); no request reached an older app or MCP revision after 21:19:30Z. Step 2: snapshot
  `snap-purple-rain-b8ahc51q` at 21:21:39Z. Step 3: `0010_park_guides` at 21:21:46Z (journal 11
  entries; `report_guide_source` gone, its function, both guide rows and the tables kept;
  no guide account, no `ready` guide). Live: health 200 ×3, app home 200, MCP 401
  unauthenticated, forms probe PASS, MCP reads with no guide, e2e passed before and after
  0010 (`milton-e2e-daily-zznm9`, `-46mf5`). Checks on the merge (`5b14877`, same tree): CI
  green. Gate at 21:32Z (from 21:19Z, covering 0010): clean.
- **#68 (Peter's go and wording; milton-qa), `6fd0330`:** deletion removes the account's
  sign-in grant bindings and the AI registrations only it approved (native 008, see
  [its section](#2026-11-08-deletion-removes-sign-in-grants-and-ai-registrations-native-008-pr-68)).
  No auth image: #68 changes no runtime code. Snapshot `snap-morning-frog-b8rqnt3c` at
  21:12:28Z; 008 at 21:12:52Z on the first attempt (ledger 001–008); the leftover-binding
  check returned 0; one link backfilled, for the one AI registration (the other
  registration is the app's own sign-in client, which nobody consents to and deletion never
  touches), nothing cleared; runtime audits `ok` for app and MCP; an e2e sign-in passed
  (`milton-e2e-daily-zfq9v`). The privacy page (dated November 8, 2026, Peter's sentence on
  registrations that can no longer be linked) is live on www.meetmilton.com. Checks: PR CI
  green on `370cce0` (same tree); on main the integration job failed once in "usage rows
  skipped behind short FOR UPDATEs" (timing; #68 does not touch it) and passed on rerun.
  Gate at 21:23Z (from 21:12Z): clean.

- **#69 (milton-qa; Astra's must-fix, the Bearer challenge, fixed), `f464237`:** native
  UserInfo answers only while the token's grant binding is live (`binding_status` after the
  rate gate; 401 `invalid_token` with its challenge, 503 on a database error). Auth
  `milton-auth-00020-hef` at 19:05:44Z (image
  `sha256:2465afc8731b5f6de6d775fb0bdfd16f77b25714492e023aa556380f2f221554`; mail and
  maintenance jobs too; `AUTH_ADMISSION_URL` kept). Live: UserInfo without a token 401
  `Bearer`, with a junk token 401 `Bearer error="invalid_token"`; an e2e sign-in passed (the
  app's own UserInfo); an MCP read. Checks on the merge: types, 156 tests, format, guard,
  auth build, auth integration 21/21, rehearsal 21/21, CI green. Gate at 19:15Z: clean.
- **#65:** runbook only (the milton-admit step-1 snippet). No deploy.

- **#64 (Peter's go; milton-qa, Astra's must-fix fixed in comments), `252fbf7`:** snapshot
  `snap-rapid-wind-b8xon9wq` at 17:58:11Z; owner file 013 as `milton_app_owner` through the
  direct host dropped `milton_app.session.access_token` (column absent; runtime audits `ok`
  for app and MCP; an e2e sign-in passed, `milton-e2e-daily-rbdc4`). No code release. The app
  must not roll back before #62 (`milton-app-token-0f7d5aa`) without that snapshot.
- **#63 (Peter's go, min 1; milton-qa, Astra PASS), `20b0f27`:** admission moved to the
  private Cloud Run service `milton-admit` (see [Admission service](deploy/cloud.md#admission-service-milton-admit)).
  Step 1: `milton-admit@`, payload `milton-admit-env:2` (six values; version 1 disabled
  because dotenvx named its keypair after the file) and `milton-admit-key:2` (version 1
  disabled for a trailing newline), runtime audit through the payload `ok`, the service
  from [admit.service.json](../server/deploy/admit.service.json) (image
  `sha256:e11636a5a5d3e0101c6406c735e021046762636f5fe838fcc3de98836548494b`, one warm
  instance), the one invoker `milton-auth@`; `run.app` answered 403 without a token, 401 with
  an owner token and no bearer, 404 off its routes; the alerts now include `milton-admit`.
  Step 2: auth `milton-auth-00018-heq` at 18:03:52Z with `AUTH_ADMISSION_URL` (mail job too,
  maintenance on the same image; image
  `sha256:e1b9476dcbd99aaab3939010bc97b0ba40913bef569b0112e80e990c768131ff`); an e2e sign-in
  admitted through `milton-admit` (204, 175 ms), no `auth_admission_identity`. Step 3: app/MCP
  `milton-*-admit-20b0f27` at 18:05:23Z (the daily job too); `/internal/auth/*` answers 404
  on app and MCP through the load balancer; health 200 ×3, forms probe PASS, an MCP read, a
  second e2e sign-in admitted (204, 120 ms). Checks on the merge: types, 156 tests, format,
  migration guard, server and auth builds, auth integration 20/20, rehearsal 21/21, CI green.
  Release gate from 17:58:11Z (covering #64 and all three #63 steps) at 18:15Z: clean.

- **#58 + #59 (milton-qa; #59 Astra PASS at `65fbf86`), `8d3d4df`:** the daily check follows
  native's JSON redirects under Node; MCP error results carry a code and `next`, the
  instructions are 3,420 characters and the server has a 117-character description. App/MCP
  `milton-*-next-8d3d4df` at 17:25:10Z (image
  `sha256:c6c2f02c88a7d17ae1f0499e636069313112adb65d4c995727f0c52ab5d83283`). Checks on the
  merge: types, 146 tests, format, site, server build, rehearsal 18/18, all 0; the merged
  bundle passed 14/14 under Node against production. Live: health 200 ×3, app home 200, MCP
  401 unauthenticated, an MCP read, forms probe PASS. Gate at 17:35Z: clean.
- **Daily check (Peter's go):** `milton-e2e-daily` on that image passed 14/14
  (`milton-e2e-daily-qzn4p`); scheduler `milton-e2e-daily` created paused, URL checked
  (`…/jobs/milton-e2e-daily:run`), resumed at `7 14 * * *` UTC (first run 2026-11-09 14:07Z).
  The job moves with each app/MCP image. Its alert (`milton-e2e-daily.policy.json`) was
  applied 2026-11-09 07:25Z, after the 07:15Z failure of the first run left its 24-hour
  window; applying it earlier would have emailed a stale failure.
- **#60 + #61 (milton-qa; Astra's last findings fixed, deltas read by milton-qa), `1a82fde`:**
  propagation, isolation and deletion integration groups (served change: the
  behavior-preserving `cloudRequests` extraction), and the migration guards in CI (numbering,
  released-file hash lock, deletion inventory, `-- code-stopped-by: #NN` drop order, tool
  description budget). App/MCP `milton-*-guards-1a82fde` at 17:36:00Z (image
  `sha256:81a1bd5fd23b5f19e0aaf3b064bc931e0c725f80f7d25da699e88d42e6ca78c1`). Checks: types,
  153 tests, format, migration guard (37 files locked; hashes match the production journal),
  server build, rehearsal 21/21, CI green. Gate at 17:46Z: clean.
- **#62 (Peter's go; milton-qa, Astra PASS), `0f7d5aa`:** the app no longer stores the native
  access token. Snapshot `snap-sparkling-firefly-b8p4mpum` at 17:46:16Z; owner file 012 as
  `milton_app_owner` through the direct host (the pooler refuses the `role` startup option),
  `is_nullable` now `YES`. App/MCP `milton-*-token-0f7d5aa` at 17:47:15Z (image
  `sha256:9ee5fb568baa1bad42014646996227983079c9c32207a11a4fc613e2810e0d06`; the daily job
  too). An e2e run signed in and passed; sessions storing a token since the release: 0.
  Checks: types, 153 tests, format, migration guard, server build, rehearsal 21/21, CI green.
  The column drop (step 2) is milton-qa's next PR; after it, the app must not roll back
  before #62.
- Earlier today: #56 alerts as code, #57 test account (auth `00016-kul`, 0009/011), #53–#55,
  the owner password reset, Neon autoscaling and the budget, daily snapshots
  (11:00 UTC, 14 days; first `snap-silent-feather-b84f2kwj`).

Since the #78 snapshot's deletion (2026-11-10): below #76 only by restoring
`snap-holy-cloud-b8jmn8q3` (before 0012), which loses every write since; the
`snap-mute-water-b85o19c9` path in the #78 line below is void.
Since #85: app/MCP `milton-*-flat-1e6d859`, admit `milton-admit-00008-lxx` and
`milton-e2e-daily` on image `sha256:1be0d2c5…`; rollback, code only, to app/MCP
`milton-*-rank-898f9ad`, admit `milton-admit-00007-rpn` and the daily job to image
`sha256:093ace98…`.
Since #83: app/MCP `milton-*-rank-898f9ad`, admit `milton-admit-00007-rpn` and
`milton-e2e-daily` on image `sha256:093ace98…`; rollback, code only, to app/MCP
`milton-*-setup-c3ed021`, admit `milton-admit-00006-gjl` and the daily job to image
`sha256:27219d38…`.
Since #78 (0013 and 015): app, MCP and admission never roll back below #76
(`milton-*-memos-bdac60f`, `milton-admit-00005-vp2`); the old tables, old receipts and guide
roles come back only by restoring snapshot `snap-mute-water-b85o19c9`, which loses every
write since. The #76 rollback line below is void.
Since #79/#80: app/MCP `milton-*-setup-c3ed021`, admit `milton-admit-00006-gjl` and
`milton-e2e-daily` on image `sha256:27219d38…`; rollback, code only, to app/MCP
`milton-*-memos-bdac60f`, admit `milton-admit-00005-vp2` and the daily job to image
`sha256:b2952441…`.
Since #76: app/MCP `milton-*-memos-bdac60f`, admit `milton-admit-00005-vp2` and
`milton-e2e-daily` on image `sha256:b2952441…`; rollback, code only (0012 and 014 stay), to
app/MCP `milton-*-sayai-74f6153` and admit `milton-admit-00004-q7h`, and the daily job to
image `sha256:73b1ae07…` with them (each check fails against the other MCP).
Since #86: auth `milton-auth-00020-k77` and both auth jobs on image `sha256:11946548…`;
rollback, code only, the service to `milton-auth-00019-p4f` and both jobs to image
`sha256:dc55298e…`.
Since #77: auth `milton-auth-00019-p4f` and both auth jobs on image `sha256:dc55298e…`;
rollback the service to `milton-auth-00018-hcv` and both jobs to image `sha256:51a8d3e3…`.
Since #75: auth `milton-auth-00018-hcv` and both auth jobs on image `sha256:51a8d3e3…`;
rollback the service to `milton-auth-00017-swp` and both jobs to image `sha256:b129db3d…`
together (a job on the older image fails mail the new one queued in the last 15 minutes).
Since #74: app/MCP `milton-*-sayai-74f6153`, admit `milton-admit-00004-q7h` and auth
`milton-auth-00017-swp`; rollback, in any order (text only), to app `milton-app-race-778a1a1`,
MCP `milton-mcp-park-f735701`, admit `milton-admit-00003-rmr` and auth `milton-auth-00016-q4c`.
Since #71: app `milton-app-race-778a1a1`, admit `milton-admit-00003-rmr` and auth
`milton-auth-00016-q4c`; rollback, in any order, to `milton-app-srl-7ffc5cf`,
`milton-admit-00002-ws6` and `milton-auth-00020-hef` (code only; the erase step then no longer
ends a customer linked after deletion began). Before #71: auth `milton-auth-00020-hef`, rollback `milton-auth-00018-heq` (code only); floor `00018-heq` (older auth calls the
app's removed admission routes: roll auth back only together with app/MCP to
`milton-*-token-0f7d5aa`, then auth to `00016-kul`). App `milton-app-srl-7ffc5cf`, rollback `milton-app-park-f735701` (code only; it runs on
0011), and admit `milton-admit-00002-ws6`, rollback `milton-admit-00001-ggf`; roll both back
together, then, once the new code returns, run the resync again. MCP `milton-mcp-park-f735701`.
Before those, app/MCP `milton-*-park-f735701`,
rollback `milton-*-admit-20b0f27` (code only; with no guide account it serves no stale guide), then `milton-*-token-0f7d5aa` (never before #62). Once owner file 013 is applied, the app never rolls back to an image older than #62:
`milton-app-token-0f7d5aa` is its floor, and `milton-app-guards-1a82fde` is no longer a
rollback (its sign-in writes the dropped column). MCP never touches sessions; its rollback
is unchanged. See [Drop the app session's access-token column](#2026-11-08-drop-the-app-sessions-access-token-column-owner-file-013-pr-64).
Earlier records: git history (`git log -p server/deploy/README.md`).

## 2026-11-10: Drop save_requests.source_hash (Drizzle 0014, PR #82)

Nothing has ever read `save_requests.source_hash`, and saves stopped writing it in #45, which
0006 made possible by dropping its NOT NULL. `0014_drop_source_hash` names #45 in its
`-- code-stopped-by:` line, drops the column and rewrites the `save_request_hashes` check to
test `input_hash` alone. It drops the check by name before the column and re-adds it after,
so nothing goes implicitly, and uses no CASCADE. `save_requests`' rows, its guard trigger
and its grants stay.

**Migrate first; no code release has to come before it.** Every app/MCP revision from #45 on
names only `user_id`, `request_id`, `input_hash` and `result_json` on `save_requests`: the
receipt lookup `SELECT input_hash,result_json FROM save_requests WHERE user_id=$1 AND
request_id=$2` and the insert `INSERT INTO save_requests(user_id,request_id,input_hash,result_json)`
in `save.ts`, both plain SQL. The table's Drizzle declaration in `schema.ts` (which still
listed `source_hash` up to this change) is read only by drizzle-kit and the tests; no request
builds a query from it. Checked on PostgreSQL 18 with every statement logged: the save
path of main `c3ed021` and of #76's `bdac60f` (a saved memo, its replay, a refused save and a
cover sheet line) ran on a database migrated through 0014 with no error, and no logged
statement named `source_hash`. This change's own code (the schema declaration without the
column) ships with the next release, in either order. The rollback floor stays #76
(`milton-*-memos-bdac60f`, `milton-admit-00005-vp2`, see the 0013 section); 0014 moves no
revision off the list of safe rollback targets. Code older than #45 writes `source_hash`,
but it was already below the floor.

Rehearsed by `check-auth-integration.ts` (applies 0014 after 0013 on PostgreSQL 18 and saves
through the MCP runtime role; PR CI `integration`) and by `store-migrations.test.ts` (a
receipt with `source_hash` and a memo-era one survive 0014, and the replay returns its
stored outcome). Each step needs Peter's go; the release coordinator runs it:

1. Snapshot production and record its name. Record, as `neondb_owner`, what the release
   removes (the column's values are hashes of old inputs that nothing reads):

   ```sql
   SELECT count(*) AS receipts, count(source_hash) AS with_source_hash FROM save_requests;
   ```

2. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0014_drop_source_hash`
   (journal 15 entries). Each statement takes an `ACCESS EXCLUSIVE` lock on `save_requests`
   until commit, so every statement on `save_requests`, a save's receipt lookup and any
   other `SELECT` included, waits for it. 0014 locks no other table, but a save takes its
   account's `users` row lock (`FOR NO KEY UPDATE`) before its receipt lookup, so a save
   blocked here keeps that row lock, and the same account's other saves and anything else
   that locks its `users` row (an erasure, a status change) wait behind it until 0014
   commits or reaches its lock timeout. Other accounts' reads, and every request that
   touches neither `save_requests` nor a blocked account's row, do not wait. A save holds
   its own lock on `save_requests` from its receipt lookup to its commit, so the migration
   also waits for saves in flight. Its `SET LOCAL lock_timeout = '5s'` (inside the
   migration's transaction, since Neon drops the limits a client passes at connect) bounds
   that wait: on a lock timeout it rolls back whole, releasing every waiter, and is simply
   rerun. The work under the lock is catalog changes and one scan of `save_requests` (tens
   of rows) to validate the new check, so once it has the lock it holds it for
   milliseconds.
3. Check as the owner. The first query returns 0; the second returns
   `CHECK ((input_hash ~ '^[a-f0-9]{64}$'::text))`; the third returns 0 (no row violates
   the check); the fourth returns 15. The last records the receipt count for the record
   only: with traffic open a save raises it and an account erasure lowers it, so it need
   not match step 1's.

   ```sql
   SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'save_requests' AND column_name = 'source_hash';
   SELECT pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid = 'public.save_requests'::regclass AND conname = 'save_request_hashes';
   SELECT count(*) FROM save_requests WHERE input_hash !~ '^[a-f0-9]{64}$';
   SELECT count(*) FROM drizzle.__drizzle_migrations;
   SELECT count(*) AS receipts FROM save_requests;
   ```

   Then `check-runtime-role.ts` prints `ok` for app and MCP, one manual `milton-e2e-daily`
   run passes (it saves, so it writes a receipt), and MCP logs show no `store_unavailable`
   or `check_violation`.

Rollback: if 0014 fails, its transaction rolls back and changes nothing; fix the cause and
rerun. Once it has committed, nothing serving needs the column, so no code rollback calls
for a database one: every revision at or above the #76 floor runs on either schema. The
pre-migration snapshot is the only way back to the column and its values (restoring it
loses every write since; see [Database recovery](deploy/migrations.md#database-recovery)); there is no down
script.

## 2026-11-10: Drop the old writing tables (Drizzle 0013, owner file 015, PR #78)

The follow-up drop and wipe from #76 (separate go from Peter on the day). Since #76 no code
reads or writes the writing tables memos replaced. Owner file `015-drop-guide-roles.sql`
runs first: it revokes what the cluster-level `milton_guide_worker` role and the NOLOGIN
`milton_guide_runtime` hold in `milton` and drops both, which no Drizzle migration can. It is
one transaction and drops nothing else, so if it fails nothing destructive has run.
`0013_drop_old_writing` then names #76 in its `-- code-stopped-by:` line and drops
`accepted_changes`, `instruction_card_versions`, `instruction_cards`, `sample_versions`,
`samples`, `sample_kinds`, `report_guides`, `guide_accounts`, `guide_spend` and
`guide_budget_lock` (with their triggers, constraints and grants), the
`instruction_card_position` sequence and the eight functions only they used
(`milton_accepted_change_guard`, `milton_card_guard`, `milton_card_version_guard`,
`milton_guide_source_changed`, `milton_sample_guard`, `milton_sample_kind_guard`,
`milton_sample_version_guard`, `milton_sample_context_valid`).

0013 deletes only the old store's `save_requests` rows, whose outcomes can quote old
writing, and keeps every receipt the memo code wrote. Without them a replay would run again:
a replayed save of a memo since forgotten would save it again, and a replayed context
correction would undo a later one. The two are told apart by the outcome's shape (0013's
header gives the rule); a failed old receipt whose code the memo code also stores is
indistinguishable and stays, and its message is fixed text. One known exception, harmless:
`compiler_input_limit`, a retired old-store-only code that 0013's delete list leaves out, so
its receipts stay too (production holds one, from 2026-10-31, with no message or writing).
`save_requests`, its guard and its grants stay.

**Roles on Neon.** Both roles were made with SQL (`milton_guide_worker` by Drizzle 0003,
`milton_guide_runtime` at the 2026-11-07 cutover), and Neon's API lists them among the
branch roles because its `neon` extension forwards role DDL to the control plane. The same
extension forwards `DROP ROLE`, also from inside 015's `DO` block, when the transaction
commits, and fails the transaction if the control plane refuses
([`pgxn/neon/neon_ddl_handler.c`](https://github.com/neondatabase/neon/blob/main/pgxn/neon/neon_ddl_handler.c)),
so a SQL drop keeps the API's list in step and no API delete is needed. The gap it
documents: it forwards before PostgreSQL commits, so a commit that fails (or whose outcome
is uncertain) after the forward can leave the control plane without roles PostgreSQL kept. A compute start recreates every role the
control plane still lists, as a `neon_superuser` member
([`compute_tools/src/spec_apply.rs`](https://github.com/neondatabase/neon/blob/main/compute_tools/src/spec_apply.rs)),
so step 3 compares the two lists after every 015 attempt, failed or not, before anything
else.

After 0013, `005-app-roles.sql` names dropped tables and fails, so it is never rerun; its
other grants stay in place. A fresh install applies the owner files through 015 before 0013
(server README). The serving #76 images never name the dropped objects, so no image release
is needed; this change's code (schema declarations and refusal codes nothing raises any more)
ships with the next release. Rehearsed by `check-auth-integration.ts` (015 twice, then 0013,
on PostgreSQL 18 with rows in the old tables and an old and a memo receipt; PR CI
`integration`).

**This is not a code-only release.** After 0013 the app, MCP and admission never roll back to
an image older than #76 (`milton-*-memos-bdac60f` and `milton-admit-00005-vp2` are the floor),
and the pre-migration snapshot is the only way back to the old tables, the old receipts and
the roles. Restoring it loses every write since (see [Database recovery](deploy/migrations.md#database-recovery)).
Each step needs Peter's go; the release coordinator runs it:

1. Confirm no app, MCP or admission revision older than #76 serves traffic, then snapshot
   production and record its name. Record, as `neondb_owner`, what the release removes:

   ```sql
   SELECT (SELECT count(*) FROM save_requests) AS receipts,
     (SELECT count(*) FROM instruction_cards) AS cards,
     (SELECT count(*) FROM samples) AS samples,
     (SELECT count(*) FROM guide_accounts) AS guide_accounts;
   ```

2. As `neondb_owner`:
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/015-drop-guide-roles.sql` (one
   transaction; rerunning converges). If it fails, PostgreSQL rolled it back, but Neon's
   control plane may already have recorded the drops: do step 3's comparison before any
   compute restart. Its error names what a role still holds or owns (another database's
   grant, an owned object); resolve that and rerun it, and do not go on to 0013 until it
   succeeds.
3. After every 015 attempt, failed, uncertain or successful, compare the two lists. On
   success, `SELECT rolname FROM pg_roles WHERE rolname LIKE 'milton_guide%';` returns no rows,
   and the branch's role list in the Neon console or API (`GET
/projects/{project_id}/branches/{branch_id}/roles`) no longer shows either role. If the
   two disagree (after a failed attempt too), stop and resolve it with Neon before 0013, and
   do not restart the compute meanwhile.
4. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0013_drop_old_writing`
   (journal 14 entries). Each drop locks its table exclusively and, for a foreign key to
   `users`, `users` too until commit, so every request waits for it. Its 5 s lock limit
   bounds the wait for each lock, not the statements' run time: on a lock timeout it rolls
   back whole and is simply rerun. The work under the locks is catalog changes and one
   `DELETE` that scans `save_requests` once (46 receipts on 2026-11-08, about 10 more a day
   from the daily check), so it holds them for milliseconds.
5. Check as the owner. The first query returns no rows; the second returns
   `milton_save_request_guard`, `milton_user_id_guard` and `prune_usage_calls`; the third
   returns 0; the fourth lists what is left, for the record (every `error` a code the memo
   code stores, except the known `compiler_input_limit` receipt above):

   ```sql
   SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace
     AND relname IN ('accepted_changes', 'instruction_card_versions', 'instruction_cards',
       'instruction_card_position', 'sample_versions', 'samples', 'sample_kinds',
       'report_guides', 'guide_accounts', 'guide_spend', 'guide_budget_lock');
   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1;
   SELECT count(*) FROM save_requests WHERE result_json ?| ARRAY['version', 'question',
     'samples_retired'];
   SELECT result_json->>'status' AS status, result_json->>'error' AS error, count(*)
   FROM save_requests GROUP BY 1, 2 ORDER BY 1, 2;
   ```

   Then `check-runtime-role.ts` prints `ok` for app and MCP, one manual `milton-e2e-daily`
   run passes, and app, MCP and admit logs show no `permission denied` or
   `store_unavailable`.

Rollback: if 0013 fails, its transaction rolls back and changes nothing; if 015 fails,
PostgreSQL rolls it back, and step 3's comparison settles Neon's list. Fix the cause
and rerun. After 015 alone, nothing serving needs the roles, so there is nothing to roll
back. Once 0013 has committed, the pre-migration snapshot is the only rollback; there is no
down script.

## 2026-11-09: Memos and tweaks (Drizzle 0012, owner file 014, PR #76)

0012 adds seven tables (`memos`, `memo_kinds`, `tweaks`, `tweak_citations`,
`served_reports`, `cover_sheets`, `memo_settings`), each cascading from `users`, and revokes
the legacy `milton_runtime` group's default grants on them. It alters no existing table,
function, trigger or grant, so the serving code runs on it unchanged. 014 grants the app and
MCP runtimes exactly what the new code uses; neither can change a memo's words. The new code
reads and writes only the new tables: from the moment it serves, rules, samples and the
fixed reports are no longer served or saved, and nothing is migrated (spec, Peter
2026-11-09). The old tables keep their rows until the follow-up drop (below). At preparation
(2026-11-09) production held two real accounts: Peter's (16 samples, 43 cover sheet rule
cards) and one other (1 card), plus the test accounts.

Rehearsed by `check-auth-integration.ts` (applies 0012 and 014 on PostgreSQL 18; PR CI
`integration`). Each step needs Peter's go; the release coordinator runs it:

1. Snapshot production and record its name.
2. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0012_memos` (journal 13
   entries). Its foreign keys to `users` briefly block writes to `users` (sign-ups,
   deletions) until it commits; it sets a 5 s lock limit, so on a lock timeout it rolls back
   whole and is simply rerun.
3. As `neondb_owner`, at once:
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/014-memos-roles.sql` (one transaction;
   rerunning converges).
4. Check as the owner: the seven tables exist and are empty, and the grants match 014:

   ```sql
   SELECT r, t, has_table_privilege(r, 'public.' || t, 'SELECT') AS sel,
     has_table_privilege(r, 'public.' || t, 'INSERT') AS ins,
     has_table_privilege(r, 'public.' || t, 'DELETE') AS del,
     has_column_privilege(r, 'public.memos', 'final', 'UPDATE') AS can_reword_memo
   FROM unnest(ARRAY['milton_app_runtime','milton_mcp_runtime']) r,
     unnest(ARRAY['memos','memo_kinds','tweaks','tweak_citations','served_reports',
       'cover_sheets','memo_settings']) t ORDER BY 1, 2;
   ```

   `can_reword_memo` is `f` on every row. Then `check-runtime-role.ts` prints `ok` for app
   and MCP.

5. Release one server image to `milton-admit` (digest in [admit.service.json](../server/deploy/admit.service.json)),
   `milton-app` and `milton-mcp` (`--no-traffic` tag, then `update-traffic`), and move
   `milton-e2e-daily` to it in the same step: the new check expects three tools and the old
   one fails against the new MCP, and the daily alert pages after 13 hours without a pass.
6. Verify: health ×3, MCP 401 unauthenticated, forms probe, one manual
   `milton-e2e-daily` run (steps below), and no `permission denied` or `store_unavailable`
   in app or MCP logs. Peter opens his TPS page. Connected AIs see the new tools only after
   they reconnect.
7. Peter tells live accounts their writing was reset; the other account's notice is his
   to send (drafted for him, never sent for him).

Rollback: code only, to the revisions under "Now serving" before this release; they never
name the new tables, so 0012 and 014 stay. Memos saved meanwhile stay in the new tables,
invisible to the old code, and old-table writes resume. The snapshot is 0012's rollback only
before the new code serves; there is no down script.

After the drop below, this rollback no longer exists: code older than #76 reads the dropped
tables.

## 2026-11-09: Auth mail hardening (PR #75)

Code only: no migration, no new table (the per-address cap is a `take_rate` bucket in
`milton_guard.rate_bucket`). One auth image carries all of it; build, then deploy it to
`milton-auth` and both jobs exactly as in the last auth release (check the serving revision
and move traffic with `update-traffic`).

- **Domain check and per-address cap:** nothing to configure. Auth's Cloud Run service must
  resolve public DNS (the default metadata resolver does). After release, a sign-up at a
  domain with a null MX logs `auth_mail_skipped` (`undeliverable_domain`) in milton-auth's
  log, and a fourth reset for one address in an hour logs `account_cap`.
- **Reply-To:** nothing to configure: `AUTH_MAIL_REPLY_TO` defaults to
  `support@meetmilton.com` (set it only to change that). It is bound into each encrypted
  message, so the mail job must run the same image as the service: update
  `milton-auth-mail` in the same step. A message the old image queued (no Reply-To) still
  sends under the new one; rolling the job back to an older image fails, as `failed`, any
  message the new image queued in the previous 15 minutes, so roll back service and job
  together. Check: reply to one real verification email and see it reach support.
- **Mail alert (after the image is on `milton-auth-mail`):** the job now logs each pass as
  one JSON line (`{"message":"auth_mail_pass",…}`), not the old text line, and one line
  per failed or throttled send (`{"message":"auth_mail_send","outcome":…}`) and per pause a
  throttle sets (`{"message":"auth_mail_pause","seconds":N}`). Once a pass has run on the
  new image, confirm it parsed:
  `gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="milton-auth-mail" AND jsonPayload.message="auth_mail_pass"' --project=milton-510506 --freshness=10m --limit=1`
  returns an entry. Then `bun server/scripts/monitoring.ts` (plan: create the log metrics
  `milton-auth-mail-problems` and `milton-auth-mail-long-pause` and the page policy
  `milton-auth-mail`, the rest unchanged) and `--apply`; a second plan is all unchanged. It
  pages on 3 or more failed or throttled sends combined in 15 minutes (Peter's decision,
  2026-11-09), or on one pause over 15 minutes. The pause metric's numeric comparison
  (`jsonPayload.seconds>900`) is unverified against live entries until the first throttle.
  Applying before the image only means the metrics count nothing until it lands.

## 2026-11-08: Stripe reads off the row lock (Drizzle 0011, PR #70)

Checkout's live read and the webhook now read Stripe with no transaction open and write by
compare-and-set on `trial_accounts.stripe_revision` (server README). Sign-in enrolment and
account deletion are unchanged: they still call Stripe under their locks (TODO.md). 0011 is
additive; older code never names the column. Older revisions' writes of the Stripe state (the
webhook, checkout, and sign-in enrolment on admit) do not advance the revision, so while both
versions serve, a new read in flight could land over one of them, where the old row lock kept
them apart, and record its event, so a redelivery is deduplicated and repairs nothing. A
stale state would last until that customer's next Stripe event. Checkout does not repair it:
it sends a stored trialing, active, past_due, unpaid or paused status to the portal without
reading Stripe. So the release ends with a one-off resync that re-reads every stored
customer:

1. Rehearse (`check-auth-integration.ts` applies 0011), then snapshot production.
2. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0011_stripe_revision`
   (journal 12 entries). Old code runs on it unchanged.
3. In a quiet window (no webhook delivery, checkout or admission in milton-app's and
   milton-admit's request logs for the last 2 minutes), release the image to `milton-app`
   and `milton-admit` back to back, so the mixed window stays short, then wait until neither
   previous revision serves a request (app timeout 60 s, admit 30 s).
4. Once both services run the new image and the old revisions have drained, run the resync
   from a checkout of the released commit, set up as for the backfill below:
   `bun --no-env-file scripts/backfill-subscriptions.ts --resync` (dry run: the count of
   stored customers), then the same with `--apply`. It re-reads each from Stripe as a webhook
   does and writes through the same compare-and-set, at about 5 a second. A nonzero exit
   means a read failed or a write conflicted twice: rerun it until it exits 0.

Rollback: code to the previous revision, which runs on 0011; the pre-migration snapshot is
0011's rollback, and there is no down script.

## 2026-11-08: Deletion removes sign-in grants and AI registrations (native 008, PR #68)

Native 008 adds `milton_guard.client_link` (account, registration), written by
`consent_gate` whenever an account consents to an AI registration, and
`milton_guard.cleared_client` (SHA-256 of each cleared or deleted registration's client
ID, no foreign key) with the `keep_cleared` insert-and-update trigger, and replaces
`consent_gate` and `cleanup_operation`: a deletion's cleanup now also takes the account's
links (deleting a registration no other account links, otherwise clearing its `name` and
`contacts`, and marking it either way) and, in the same step as the native user, its
sign-in grant bindings. It backfills links from existing consents, consented bindings and
native's disconnect records (`milton_guard.security_operation`), each matched to the
user's recorded identity incarnation, applies the rule to registrations named by a
consented binding or disconnect record of a deleted identity, and then deletes bindings
of deleted identities that nothing references. App and MCP code do not change. The same
release's auth image adds the UserInfo binding check (live `binding_status` before native
answers); it uses only 003's functions, so the image and 008 can go in either order, and
any recorded revision runs on either schema.

Its first statement locks `milton_auth."user"`, `"oauthClient"`, `"oauthClientResource"`,
`"oauthConsent"`, `"oauthAccessToken"`, `"oauthRefreshToken"` and
`milton_guard.authorization_binding` in EXCLUSIVE mode with NOWAIT. If any sign-in,
consent, token, registration, disconnect or deletion is writing them, 008 fails at once
with `55P03` (lock not available), applies nothing and records no ledger row: run step 2
again. Once it holds them, no service transaction or cleanup can hold or take a lock it
needs, so none can deadlock with it. It can still wait on another owner session (one
holding the migration ledger, or running owner DDL): open no other owner session while
it runs (the migrator's advisory lock already keeps a second migrator out). Until it commits, reads
continue (MCP, app sessions, pages) and every write to those tables waits: sign-in,
consent, token issue and refresh, registration, disconnect and deletion. The rehearsal
took 25 ms on empty tables; production time scales with the clients, consents and
bindings it scans, and is unmeasured. Rehearse on a disposable branch or database first
(both integration suites apply it), then:

1. Snapshot.
2. As `milton_auth_delegate` assuming `milton_auth_owner`:
   `node --experimental-strip-types apps/auth/scripts/migrate.ts up --apply` applies
   `008-deletion-links` (native ledger 001–008). On `55P03`, rerun.
3. Check as the owner that no binding the sweep should have removed remains (the same
   exclusions as 008's sweep: an unfinished operation, or a token, consent or code
   still referencing it, keeps a binding on purpose); this returns 0:

   ```sql
   SELECT count(*) FROM milton_guard.authorization_binding b
    WHERE NOT EXISTS(SELECT 1 FROM milton_auth."user" u WHERE u.id=b.origin_user AND u."miltonIdentityIncarnation"=b."miltonIdentityIncarnation")
    AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthAccessToken" a WHERE a."referenceId"=b.reference)
    AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthRefreshToken" r WHERE r."referenceId"=b.reference)
    AND NOT EXISTS(SELECT 1 FROM milton_auth."oauthConsent" c WHERE c."referenceId"=b.reference)
    AND NOT EXISTS(SELECT 1 FROM milton_auth.verification v WHERE v.id=b.code_record)
    AND NOT EXISTS(SELECT 1 FROM milton_guard.security_operation o WHERE o.progress<>'complete' AND b.reference=ANY(o.targets));
   ```

   and `check-runtime-role.ts` prints `ok` for app and MCP.

Untraceable and kept as they are: a registration whose only authorizations before 008,
by a live or a deleted account, left no consent, binding or disconnect record by the time
008 runs (the AI revoked its own grant, or the grant expired unused, and
maintenance pruned both). `public.assistant_disconnects` cannot help: nothing has written
it since native auth (commit `bcb59e7`), so it names no native registration. Rollback is
the pre-migration snapshot; there is no down script.

## 2026-11-08: Admission service release order (PR #63)

Each step touches production: milton-duo runs them with Peter's go. Record the current
revisions, images and secret versions first.

**1. Create `milton-admit` and its IAM.** Build and push the runtime image as for an
app/MCP release, but do not move app or MCP yet. In a no-history shell inside a private
temporary directory (`umask 077`), as in [Runtime role](https://github.com/zoneofdanger/milton/blob/d4d04913e8b65c09cb7f323dd149b2096601d3f8/server/deploy/README.md#runtime-role) step 4:

```sh
P=--project=milton-510506
SA=milton-admit@milton-510506.iam.gserviceaccount.com
gcloud iam service-accounts create milton-admit $P --display-name='Milton admission'
# The app's current payload: the version milton-app's serving revision mounts.
gcloud secrets versions access <N> --secret=milton-app-env $P > app-current.env
export DOTENV_PRIVATE_KEY="$(gcloud secrets versions access <K> --secret=milton-app-key $P)"
dotenvx decrypt -f app-current.env --stdout \
  | grep -E '^(DATABASE_URL|AUTH_ISSUER|AUTH_ADMISSION_SECRET|MILTON_TRIAL_FINGERPRINT_KEY|STRIPE_SECRET_KEY|STRIPE_PRICE_ID)=' \
  > .env
# The app's key must not encrypt the new payload: its own keypair, generated now.
# Encrypt it as `.env`: dotenvx names the keypair after the file (admit.env gave
# DOTENV_*_KEY_ADMITDEVELOPMENT), and the service reads plain DOTENV_PRIVATE_KEY.
unset DOTENV_PRIVATE_KEY
dotenvx encrypt -f .env --env-keys-file admit.keys
mv .env admit.env
grep -c '="encrypted:' admit.env   # must print 6
# Unsuffixed, and the public keys differ (they are not secret):
grep '^DOTENV_PUBLIC_KEY=' app-current.env admit.env
grep -c '^DOTENV_PRIVATE_KEY=' admit.keys   # must print 1
gcloud secrets create milton-admit-env $P --replication-policy=automatic --data-file=admit.env
# printf '%s' so the stored key has no trailing newline (grep's would be kept).
printf '%s' "$(grep '^DOTENV_PRIVATE_KEY=' admit.keys | cut -d= -f2- | tr -d '"')" \
  | gcloud secrets create milton-admit-key $P --replication-policy=automatic --data-file=-
for s in milton-admit-env milton-admit-key; do
  gcloud secrets add-iam-policy-binding $s $P --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

Match the replication of the existing secrets (`gcloud secrets describe milton-app-env`).
From the repository checkout, audit the login through the payload (`<dir>` is the
temporary directory), with the key the service will read, as it reads it:
`DOTENV_PRIVATE_KEY="$(gcloud secrets versions access latest --secret=milton-admit-key $P)" MILTON_SERVICE=app dotenvx run -f <dir>/admit.env -- bun --no-env-file server/scripts/check-runtime-role.ts`
prints `ok`. Then copy the encrypted payload to private release storage, delete the
directory, set the image digest in [admit.service.json](../server/deploy/admit.service.json),
and create the service and its one invoker:

```sh
R="--project=milton-510506 --region=us-east4"
gcloud run services replace server/deploy/admit.service.json --dry-run $R
gcloud run services replace server/deploy/admit.service.json $R
gcloud run services add-iam-policy-binding milton-admit $R \
  --member=serviceAccount:milton-auth@milton-510506.iam.gserviceaccount.com --role=roles/run.invoker
gcloud run services get-iam-policy milton-admit $R   # exactly that one binding
gcloud run services describe milton-admit $R \
  --format='value(metadata.annotations."run.googleapis.com/invoker-iam-disabled")'   # empty
```

Verify (the service URL is `https://milton-admit-419545871671.us-east4.run.app`; check it
with `--format='value(metadata.annotations."run.googleapis.com/urls")'`):

```sh
U=https://milton-admit-419545871671.us-east4.run.app
curl -s -o /dev/null -w '%{http_code}\n' -X POST $U/internal/auth/admit   # 403: no ID token
# With your own identity (project Owner): reaches the container, which refuses without its bearer.
T="$(gcloud auth print-identity-token)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $T" $U/internal/auth/admit   # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" $U/health   # 404: the admit role
unset T
```

Plan and apply the alerts (`bun server/scripts/monitoring.ts`, then `--apply`): the shared
metrics, the release gate and milton-instance-start now include `milton-admit`.

**2. Release auth pointing at it.** Deploy the auth image from this change with the URL in
the same revision (the image refuses to start without it), and move `milton-auth-mail` with
the same variable:

```sh
gcloud run deploy milton-auth $R --image=<AUTH_IMAGE@sha256> \
  --update-env-vars=AUTH_ADMISSION_URL=https://milton-admit-419545871671.us-east4.run.app
gcloud run jobs update milton-auth-mail $R --image=<AUTH_IMAGE@sha256> \
  --update-env-vars=AUTH_ADMISSION_URL=https://milton-admit-419545871671.us-east4.run.app
gcloud run jobs update milton-auth-maint $R --image=<AUTH_IMAGE@sha256>
```

Verify a sign-in admits: run `milton-e2e-daily` once (it signs in through auth), or sign
in to the app, then
`gcloud logging read 'resource.labels.service_name="milton-admit" AND httpRequest.requestUrl:"/internal/auth/admit"' --project=milton-510506 --freshness=15m --limit=5 --format='value(httpRequest.status,httpRequest.latency)'`
shows 204, and auth's log has no `auth_admission_identity`.

**3. Release app and MCP without the routes** (the image from step 1), then verify through
the load balancer:

```sh
for h in app mcp; do for p in admit preserve-eligibility; do
  curl -s -o /dev/null -w "$h $p %{http_code}\n" -X POST https://$h.meetmilton.com/internal/auth/$p
done; done   # 404 each
```

**Afterwards (optional, recommended):** mint the next `milton-app-env` version without
`AUTH_ADMISSION_SECRET`, which the app no longer reads, so the app's account no longer
holds it. Older app revisions keep their pinned version.

**Rollback.** `milton-admit` rolls back by revision like any service. App or MCP may roll
back to a pre-change revision: that only reopens the old public route, which nothing calls.
**After step 3, rolling auth back to an image from before this change breaks sign-in:** it
calls `https://app.meetmilton.com/internal/auth/admit`, which now answers 404, so every
authorize and consent accept fails with `admission_retry_required` and unlink with
`eligibility_preservation_retry_required`. Treat the step 2 auth revision as auth's rollback
floor. If an older auth must run, first roll the app back to a revision that still serves
the routes (for example `milton-app-e2e-7938dd5`; code only, schema compatible), and move
it forward again once auth is current.

## 2026-11-08: Drop the app session's access-token column (owner file 013, PR #64)

Since #62 the app never writes `milton_app.session.access_token` and nothing has ever read
it; 012 made it nullable, and production has stored no token since `milton-*-token-0f7d5aa`
began serving (2026-11-08 17:47Z). 013 drops the column, so no SQL can read the tokens
older rows still hold, each expired within an hour of its sign-in. DROP COLUMN is a
catalog change with no table rewrite: it does not erase those bytes, which stay in the
tuples until the expired rows are reclaimed and vacuumed, and in WAL and snapshots until
they age out (snapshots are kept 14 days); 013 sets a 5 s lock limit in its own transaction because it briefly
locks `session` exclusively. Apply only while the app serves `milton-app-token-0f7d5aa` or
later: older app code inserts the column, so every sign-in on it fails after the drop. MCP
never touches sessions. Rehearse on a disposable database first
(`server/scripts/check-auth-integration.ts` applies 012 and 013 twice each), then:

1. Snapshot production.
2. As the `milton_app` owner, `milton_app_owner` (as for 008 and 012), through the direct
   host: Neon's pooler refuses the `role` startup option:
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/013-drop-session-access-token.up.sql`
   (one transaction; rerunning converges).
3. Check as the owner; expect no rows:
   `SELECT column_name FROM information_schema.columns WHERE table_schema='milton_app' AND table_name='session' AND column_name='access_token';`
   Then `check-runtime-role.ts` must print `ok` for app and MCP, and a fresh sign-in must
   succeed (the daily check signs in; or watch `milton-app-errors-log` for a
   `column "access_token"` error).

No code release follows; the serving images already run on either schema. After 013 the
app never rolls back to an image older than #62 (`milton-app-token-0f7d5aa` is the floor;
`milton-app-guards-1a82fde` and older write the column). If 013 fails (its lock limit, say),
its transaction rolls back and changes nothing; rerun it. Otherwise a failed migration's
rollback is the pre-migration snapshot; there is no down script.

## 2026-11-08: Test accounts (Drizzle 0009, owner file 011, PR #57)

0009 adds `users.test_account boolean NOT NULL DEFAULT false`, the owner-only mark on the
fictional end-to-end check account (see [Test account and daily check](deploy/e2e.md)).
It is additive: one column with a constant default is a catalog change with no rewrite,
every existing account reads false, and serving app/MCP code never names the column, so
traffic stays open. App/MCP code from this change on reads it (the test-account exemption
from trials and billing), so release that code only after 0009. Roll that code back like
any schema-compatible release, code only, keeping 0009 and 011 (see [Rolling back past the
test-account release](https://github.com/zoneofdanger/milton/blob/d4d04913e8b65c09cb7f323dd149b2096601d3f8/server/deploy/README.md#rolling-back-past-the-test-account-release)); never restore the
snapshot for it, which would discard every later save. 011 narrows app's INSERT on `users` to `id`, `status` and `created_at` (the
only columns it could insert before) so no runtime login can set the mark. 0009 sets a 5 s
lock limit in its own transaction: the ADD COLUMN briefly locks `users` exclusively. Rehearse
on a disposable branch or database first (`server/scripts/check-auth-integration.ts` applies
both), then:

1. Snapshot production.
2. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0009_test_account`
   (journal 10 entries).
3. As `neondb_owner`, at once:
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/011-test-account-roles.sql` (one
   transaction; rerunning converges).
4. Check as the owner. The first row is `boolean`, `false`, `NO` and 0; the next two list
   `f` for every runtime login:

   ```sql
   SELECT data_type, column_default, is_nullable,
     (SELECT count(*) FROM users WHERE test_account) AS marked
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'test_account';
   SELECT r, has_column_privilege(r, 'public.users', 'test_account', 'INSERT') AS can_insert,
     has_column_privilege(r, 'public.users', 'test_account', 'UPDATE') AS can_update
   FROM unnest(ARRAY['milton_app_runtime','milton_mcp_runtime','milton_auth_runtime']) r;
   ```

   Then `check-runtime-role.ts` must print `ok` for app and MCP. Account creation's
   `INSERT INTO users (id)` under the narrowed grant is covered by the rehearsal; in
   production the next new sign-up exercises it, so watch `milton-app-errors-log` for a
   `permission denied` after applying 011.

A failed migration's rollback is the pre-migration snapshot, used only before any code that
reads the column serves; there is no down script. Every recorded app/MCP revision runs on
either schema, so rolling code back never needs it.

### Production order

Each step needs Peter's go; the release coordinator runs it.

1. Release auth (`d2a7e78`: no mail to `.invalid` addresses), service and both jobs, and
   check health and a password sign-in.
2. Snapshot production.
3. Apply 0009, then 011, with their checks (the section above).
4. Release app and MCP (the explicit test-account exemption, which reads 0009's column).
5. Provision the account; confirm the snapshot gate (Run the check); run the check once by
   hand.
6. Create `milton-e2e-daily` (below; milton-duo).

## 2026-11-08: Usage retention and the daily allowance's leftovers (Drizzle 0008, owner file 010, PR #55)

0008 drops `usage_daily`, removes the stored `daily_calls` key from the `store_config` row
(idempotent) and from the column default, adds the index `usage_calls_by_at`, and creates
`public.prune_usage_calls(batch)`: SECURITY DEFINER as the table owner, fixed search path,
EXECUTE revoked from PUBLIC. It deletes at most `batch` (1–10,000) usage rows older than 90
days, oldest first, skipping rows an erasure has locked. Owner file 010 lets only
`milton_auth_owner` execute it. The auth maintenance job (`milton-auth-maint`, every 15
minutes, as `milton_auth_owner` through `milton-auth-owner-url`'s `milton_auth_delegate`)
then runs it after its auth cleanup: 1,000 rows per batch, at most 20 batches per run, each
batch its own transaction whose `SET LOCAL` 10 s statement and 2 s lock limits are read back
before its one DELETE (Neon drops connect-time limits, and 007 sets none for the delegate).

Since PR #40 nothing reads or writes `usage_daily` or `daily_calls`. Serving app/MCP
`*-save-b85f428` and the recorded rollback `*-rnd3-64435ee` both contain #40 (`90af817`), so
traffic stays open. App/MCP code before #40 requires `daily_calls` and refuses every tool
call without it: after 0008, roll app/MCP back no further than #40 unless the snapshot is
restored first. Auth reads no writing table. 0008 sets, in its own transaction, a 5 s lock
and a 5 s statement limit (under the runtimes' 10 s lock limit): the drop briefly locks
`users`, and the plain index build blocks usage appends until commit (each reply still waits
at most 250 ms). On a disposable PostgreSQL 18 the whole migration took 49 ms with 25,500
usage rows, and the index build alone 205 ms on 1,000,000. Rehearse on a disposable branch
or database first, then:

1. Snapshot production. It is the only copy of the dropped rows and key.
2. Size gate, read-only as the owner: `SELECT count(*) FROM usage_calls;`. Expected today:
   a few thousand at most (one row per admitted call since 2026-11-08, two accounts).
   Proceed only below 1,000,000 rows, where the plain build stays well inside 0008's 5 s
   limit. At or above it, stop: with Peter's go, first run
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_calls_by_at ON usage_calls USING btree (at);`
   as the owner, outside a transaction (it blocks no appends), confirm
   `SELECT indisvalid FROM pg_index WHERE indexrelid='usage_calls_by_at'::regclass` is true
   (drop and rebuild an invalid one), then continue; 0008's `IF NOT EXISTS` keeps it.
3. As `neondb_owner`: `bun run --cwd server db:migrate` applies `0008_usage_retention`
   (journal 9 entries).
4. As `neondb_owner`: `psql -X -v ON_ERROR_STOP=1 -f server/migrations/010-usage-retention-roles.sql`
   (one transaction; rerunning converges).
5. Check as the owner. The first two columns are null and false; the ACL lists only
   `neondb_owner` and `milton_auth_owner`:

   ```sql
   SELECT to_regclass('public.usage_daily') AS daily,
     (SELECT limits_json ? 'daily_calls' FROM store_config) AS key,
     (SELECT proacl FROM pg_proc WHERE oid='public.prune_usage_calls(integer)'::regprocedure) AS acl;
   ```

   Then `check-runtime-role.ts` must print `ok` for app and MCP.

6. Release an auth image built from this source to `milton-auth-maint` (an auth release
   moves the service and both jobs). Before steps 3–4 its prune fails (the job exits 1 after
   its auth cleanup and `milton-auth-jobs-errors-log` alerts), so release it after them. Its
   log line `Usage rows past retention removed: N` reads 0 until about 2027-02-06, 90 days
   after the first usage row.

Rollback is the pre-migration Neon snapshot `snap-snowy-haze-b8dl4hvc`; there is no down
script. Older auth images run on either schema (they never prune). Before restoring the snapshot, move the auth jobs back
to an image without the prune, or each run fails on the missing function.

## 2026-11-07: Runtime role timeouts (owner file 007, TODO #29)

Neon's proxy and pooler drop the `statement_timeout`/`lock_timeout` the pools pass at
connect (measured 2026-11-07: `SHOW` returned 0 for both through either host, while local
PostgreSQL 18 applied them), so production has no server statement or lock limit and
billing's waiter does not get its 10 s 503. One owner file sets them on the runtime logins,
in database `milton`: app and MCP 20 s statement / 10 s lock, auth 5 s statement, the values
the code already passes. Serving revisions need no change (only a statement or lock wait past
its limit now fails, as the code intends), so traffic stays open. Apply it before releasing
code whose `check-runtime-role.ts` requires it. Rehearse on a disposable Neon branch first,
then:

1. Snapshot.
2. As `neondb_owner` (ALTER ROLE needs CREATEROLE and ADMIN on each login, which the
   role that created them holds):
   `psql -X -v ON_ERROR_STOP=1 -f server/migrations/007-role-timeouts.up.sql`. One
   transaction; rerunning converges.
3. Check as the owner. This lists exactly `milton_app_runtime` and `milton_mcp_runtime`
   with `{statement_timeout=20s,lock_timeout=10s}` and `milton_auth_runtime` with
   `{statement_timeout=5s}`:

   ```sql
   SELECT r.rolname, s.setconfig FROM pg_db_role_setting s
   JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
   WHERE d.datname = 'milton' ORDER BY 1;
   ```

   Then `check-runtime-role.ts` must print `ok` for app and MCP (it now requires these
   settings).

4. A role setting reaches only sessions that start after it, and Neon's pooler keeps its
   own server connections open, independent of ours, so new Cloud Run revisions do not
   pick it up. In the 2026-11-07 rehearsal on a disposable branch, `SHOW` through the
   pooler still read 0/0 after the file applied (the direct host read 20s/10s). Only
   after a compute restart did the pooler read the new values. Then a 7 s sleep as auth
   was cancelled at 5.8 s (57014) and an MCP read behind an owner's lock was refused at
   10.7 s (55P03). So restart the production compute
   (`restart_postgres_endpoint`) in a quiet moment: every open connection drops once,
   in-flight queries fail as `store_unavailable`, and the pools discard the broken
   connections. Then run `SHOW statement_timeout;` and `SHOW lock_timeout;` as each
   runtime login through the pooler host and expect 20s/10s (app, MCP) and 5s/0 (auth).

Rollback is the pre-migration Neon snapshot from step 1. There is no down script. Code whose
role audit requires these settings fails that audit after the restore, so roll such code back
first.
