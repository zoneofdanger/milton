---
name: how-milton-works
description: Every piece of Milton's logic, one line each, until it is split into concept files
type: behaviour
covers:
  - .dockerignore
  - .github/workflows/**
  - .vercelignore
  - apps/auth/migrations/**
  - apps/auth/scripts/**
  - apps/auth/src/**
  - apps/auth/Dockerfile
  - apps/auth/Dockerfile.dockerignore
  - apps/site/astro.config.mjs
  - apps/site/src/components/**
  - apps/site/src/layouts/**
  - apps/site/vercel.json
  - packages/**
  - scripts/**
  - server/Dockerfile
  - server/drizzle.config.ts
  - server/drizzle/**
  - server/migrations/**
  - server/scripts/**
  - server/src/**
  - server/test/copy-drift.test.ts
  - server/vite.config.ts
---

# How Milton works

This is every piece of logic in Milton, one line each, so you can skim how it works.
Each section names the files it describes. When a change alters what a line says, update
that line in the same commit. Add a line for new behavior, and delete the line when the
behavior goes.

This file covers logic only. It leaves out the wording of setup questions, page copy,
CSS, and tests. For deployment steps, see [the hosting runbook](../server/deploy/README.md).
Live settings, such as whether trials are on, are held in the database and not recorded
here.

## Hosting and startup

Files: `server/src/cloud-run.ts`, `server/src/environment.ts`, `server/src/config.ts`,
`server/Dockerfile`, `server/deploy/`, `apps/site/vercel.json`.

- One Docker image runs as three Cloud Run services, and `MILTON_SERVICE` picks `app`,
  `mcp` or `admit`.
- `admit` (Cloud Run `milton-admit`) serves only auth's `POST /internal/auth/admit` and
  `/internal/auth/preserve-eligibility`; everything else is 404, and the app and MCP serve
  no `/internal/` path. It is not behind the load balancer: Cloud Run's invoker check
  admits only auth's service account, whose Google ID token auth sends in
  `X-Serverless-Authorization`, and the admission bearer stays the second check.
- Auth sends admissions to `AUTH_ADMISSION_URL`: a `run.app` origin gets a metadata-server
  ID token for that origin, cached until five minutes before expiry; a loopback origin
  (development and tests) gets none and is refused in production. A failed token fetch
  sends nothing and fails like a refused admission.
- The prepared auth service has its own canonical host, issuer and database role; app/MCP routing stays separate. Live routing changes require the release runbook.
- HTTP upgrades to HTTPS with a redirect that keeps the method.
- Vercel builds the static site from main on every push.
- Startup decrypts a dotenvx file using a separate platform-held key.
- Startup fails on bad URLs, a missing/short app client or eligibility secret (admit: a
  missing/short admission or eligibility secret or bad issuer), a bad support email, a bad
  port, or an unknown service name.
- Auth startup checks its runtime role before listening; connection failures retry with backoff for about 15 seconds, while a role refusal fails at once. App/MCP startup does no database work.
- Plain HTTP is allowed only on loopback outside production.
- On SIGTERM the server stops accepting requests and force-exits after 8 seconds.
- The image builds with Bun, then ships only the bundle and public assets to a non-root
  Node container.

## Every HTTP request

Files: `server/src/index.ts`, `server/src/cloud-app.ts`, `server/src/http.ts`,
`server/src/assets.ts`, `server/src/error-log.ts`, `server/src/pages.tsx`,
`server/src/billing.tsx`.

- A request is refused unless its Host matches that service's canonical host.
- The app rewrites each URL to its configured origin, because TLS ends upstream.
- Bodies over 256 KiB get a 413 before parsing, auth, or database work.
- The Stripe webhook keeps its own bound, also 256 KiB.
- `/mcp` goes to the MCP handler on the MCP service and returns 404 on the app.
- `GET /health` returns ok.
- `/.well-known/oauth-protected-resource` publishes the resource and its auth issuer.
- Any other path on the MCP host redirects to the app host with a 308.
- Static files are served from a fixed list of five, never arbitrary paths. A URL whose `?v=` matches the bytes' build hash caches for a year as immutable; any other URL revalidates by ETag; CSS and SVG go out brotli or gzip per Accept-Encoding.
- Errors that escape the routes show browsers a "PC LOAD LETTER" page, and everything else
  gets a JSON 503.
- Error logs hold only the location, class name, and code, never messages or tokens.

## An MCP call

Files: `server/src/handler.ts`, `server/src/token.ts`, `server/src/mcp.ts`,
`server/src/mcp-outcomes.ts`, `server/src/store/index.ts`,
`server/src/store/connection-keys.ts`, `packages/forwarded-client/`.

- Only POST and OPTIONS pass.
- Origin is deliberately not checked, so web clients reach auth from any origin. The Host
  check stops DNS rebinding and tokens authenticate every call, but this departs from the
  MCP spec's rule that servers validate Origin.
- JOSE checks EdDSA at+jwt against the exact configured issuer and MCP audience; native's fixed implicit UserInfo audience is allowed only with openid, and JWKS keys cache for 10 minutes.
- Tokens require matching client_id/azp, supported scopes and original binding/incarnation/generation; ID/session JWTs and confirmation/DPoP are refused.
- Every call checks live immutable native binding status, in the statement that looks up the account; invalid/inactive is 401, real status/key outage is 503, with no stale-positive fallback, and a bad binding refuses before scope and scope before the account.
- Both reads require milton:read; create_memo requires read+write, including direct calls. Read grants list two tools; write grants list three.
- A read-only connection is told to ask the person to reconnect with Read and write to save memos, and never offers a save.
- A bad token gets a 401 that points the client to the sign-in metadata.
- A Bearer value starting with `mk_` is a connection key; every other value takes the native token path unchanged.
- A key must be exactly `mk_` + 22-character id + `_` + 43-character secret in canonical base64url; it is looked up by id and its secret's SHA-256 compared in constant time.
- A key is bound at creation to the native issuer and subject and the identity incarnation and security generation of the validated fresh session; no runtime can change that binding, and it is never moved to a newer generation.
- Every key call asks native `milton_guard.connection_key_status` (native 007) whether that binding is still current, the native user verified and no deletion begun; a recovery, credential or method change, or a begun deletion stops the key for good, even while the writing account is still active.
- A malformed, unknown, wrong, revoked or expired key, one whose account is not active, or one whose native binding is no longer current gets the same 401 and challenge as a bad token, with no reason; a failed status lookup is a 503, never an acceptance.
- Before any database access, a process limits each source (the client address Google's load balancer appends as the second-to-last `X-Forwarded-For` entry, IPv4-mapped IPv6 as IPv4, other IPv6 by /64, else one shared `unknown` source; never the first entry) to a 5-token bucket refilled at 10 a minute in a 10,000-source LRU, where a lookup reserves a token, a failure keeps it, a success is refunded to 0.1, and an empty bucket gets 429 with `Retry-After` without a slot; lets each source run at most 3 key lookups at once, however far its bucket refills (a 4th gets 429 with `Retry-After: 1` without a slot; these counts sit outside the bucket LRU, so eviction never forgets a running lookup); and runs at most 8 key lookups at once (beyond that a quick 503 with `Retry-After: 1`). Limits are per instance (at most 3).
- A read key lists two tools and is refused `create_memo` (403); a read-and-save key lists three. Key saves are attributed to the key's id.
- Keys pass the same trial and billing gates as OAuth calls.
- A key's last use is recorded at most once a minute; failing to record it never fails the call.
- Tool-call logs for key calls carry the key's public id, never its secret.
- Each request looks up the active writing account by exact verified issuer and subject (a key's lookup requires it too); MCP never provisions an account. That lookup is the request's account check, so the store is built without a query and `initialize`, `tools/list` and notifications make no store query; each tool call's read and save check the account again.
- Each request builds a fresh stateless MCP server, with no sessions or subscriptions.
- Global instructions require `get_cover_sheet`, then `get_report` with an intent, before writing or editing for or as the person, and set precedence: what the person says now, then the cover sheet, then tweaks, then examples. Edits change only what was requested and keep the person's other words, length, tone, greeting and sign-off; guidance never widens scope, and changes are briefly listed. These are behavioral instructions, not server enforcement.
- The instructions tell the AI to save a memo with `create_memo`, without asking, when the person accepts a final (approves it, says it's done or they'll send it, or copies it to use), untouched finals included; to send the first draft exactly as first shown, or `first_draft_missing`; and to skip abandoned drafts, writing not in the person's own voice, saves the person declines and, with `keep_memos` false, anything they didn't ask it to remember.
- Tweaks are one line per change with its condition, reusing a served tweak's id; the AI never sends secrets, the person's correction messages or other people's text, and summarizes the situation in `context.summary`.
- After a saved memo the AI tells the person its one-line receipt, with no question; a failed save is reported.
- The cover sheet changes only on the person's words ("remember …", "add to my cover sheet"); the AI never adds tweaks or its own inferences, and a correction during a draft is a tweak.
- Both instruction variants stay under 3,500 characters; error handling lives in each
  error result's `next`, and the save fields in `create_memo`'s description.
- Server info carries a description of at most 120 characters for clients that drop
  instructions: read `get_cover_sheet`, then the matching `get_report`, before writing or
  editing for the person.
- Each AI's (account and OAuth client) first tool call after a server process starts
  carries `notifications/tools/list_changed` ahead of its result, as does every
  `get_report` refused for a missing intent, so clients holding tool schemas from before
  a release refresh them; the announced set is per process and in memory.
- There is no daily call allowance. A `tools/call` is admitted after access, scope and
  the store limits (the request's access statement), the input schema, the `get_report`
  intent and `kind_id`, and the trial and billing gate, right before the tool's own work
  (the read, or a save's decision under its account lock). Every refusal
  before that, `subscription_required` included, records nothing, and replaying a save
  receipt is not admitted. Admission is tracked per tool call, so calls sharing a
  request or a server are recorded independently.
- Each admitted call starts one `usage_calls` row (account, time, tool) at admission, on
  its own connection alongside the call's work; the reply waits for it at most 250 ms,
  then goes and lets the row finish in the background. Outcomes stay in the
  identity-free logs. One writer per process sends at once when idle and batches rows
  that arrive meanwhile (up to 50), holds at most one pooled connection, drops rows
  beyond 1,000 waiting, and logs a failure by class and code only; shutdown waits for it
  before closing pools. Each batch is one autocommit statement that never waits on an
  account row lock: it takes the key share of each batch account it can lock now (`SKIP
LOCKED`) and inserts only those accounts' rows, so it holds key shares only on accounts
  it writes, only while it runs. A row skipped behind its account's `FOR UPDATE` is
  retried once, 50 ms after its own skip, then dropped and logged by code. `SKIP LOCKED`
  covers row locks only: a migration holding a table lock on `usage_calls` or `users`
  can delay usage rows (as it delays requests), while each reply still waits at most
  250 ms.
- Usage is best-effort. A row is lost when it is skipped again on its retry (its
  account still under `FOR UPDATE`, or erased), when more than 1,000 rows are waiting,
  when its statement fails, or when the process exits (the 8 s shutdown bound or a
  crash) with rows still queued.
- The row's foreign key cascades from `users`, so account erasure removes it. Writers
  (saves, the TPS page's changes and key creation) lock the account
  `FOR NO KEY UPDATE`, which the row's key-share check does not wait on; sign-in,
  eligibility, lifecycle and deletion lock `FOR UPDATE`, so a row for an account being
  deleted is skipped, then dropped, and never outlives the account.
- Usage rows are kept 90 days. Only the auth maintenance job (every 15 minutes, as
  `milton_auth_owner`) deletes older ones, through `public.prune_usage_calls` (`0008`):
  oldest first by the `at` index, at most 1,000 per batch and 20,000 per run, skipping
  rows an erasure has locked. Each batch is one transaction with one DELETE under
  server-side 10 s statement and 2 s lock limits, read back first; unset, it refuses. No request path deletes usage rows.
- Each call logs the tool, outcome, time, and an error code from a fixed list, never
  text or identity.
- The tool name is read early, so calls refused before dispatch are still logged.

## The three tools

Files: `server/src/mcp.ts`, `server/src/mcp-tools.ts`.

- Exactly three tools: `get_cover_sheet`, `get_report` and `create_memo`. `list_reports` is gone, with no alias.
- `get_cover_sheet` takes no arguments and refuses any argument it is sent.
- `get_cover_sheet` returns `text` (the cover sheet), `version` (an integer, 0 before any), `memos` and `tweaks` (counts), `keep_memos` and `is_empty` (no cover sheet text and no memos), plus the setup script in `setup` while empty; a read-only connection gets a `permission` line instead of `setup`.
- `get_report` requires `intent`: `situation` (one line, at most 200 characters), `medium` (`email`, `chat`, `post`, `document` or `speech`), `audience` and `purpose` (one line, at most 100 characters each) and an optional `kind_id`.
- A `get_report` with no intent is refused with what to send and a reconnect hint; a malformed intent is refused with each limit it broke and no hint. Nothing is read either way.
- A `kind_id` the account does not have is refused (`invalid_kind`) without creating a kind.
- `get_report` returns `report_id`, `text`, `is_empty`, `examples` (`{memo_id, kind_id?, kind?, medium, tier, date}` in served order), `tweaks` (`{tweak_id, text, memos}`) and `kinds` (every kind on the account as `{kind_id, kind}`, by label).
- `create_memo` takes a UUID `request_id` and exactly one of `memo`, `cover_sheet`, `forget_memos` or `memo_context`; `memo.report_id` names the `get_report` read before the draft.
- A `create_memo` whose `memo` is plain text (not JSON) with only memo fields beside it is read as `memo: {final: that text, ...those fields}`, before validation and hashing, so either shape is one request; a JSON string `memo` beside memo fields, one beside `final`, another change or an unknown argument, and memo fields beside an object `memo` are refused (`invalid_input`) with how to send it, as is a flattened memo still malformed once read as nested, naming what is malformed.
- Every error result and every MCP HTTP refusal body keeps `error` and `message` and adds
  `code` (the `error`, or `version_conflict` for a stale-version conflict) and `next`:
  `{action, text}`, the action one of `retry`, `reread`, `fix_input`, `ask_user` or
  `tell_user`, from the one table in `mcp-outcomes.ts`; an unknown code gets the
  unexpected-failure step. The SDK's plain-text argument refusals become such bodies,
  `invalid_arguments` with the SDK's text as `message`.
- Memo codes get their own steps: `request_too_large` resaves the memo with the final alone (`first_draft_missing`); `memos_off` stops saving drafts, saving only writing the person asks to remember; `invalid_kind`, `invalid_tweak`, `invalid_memo` and `line_not_found` reread for a valid id or the exact line; `invalid_report` sends the latest `report_id` or none; `cover_sheet_limit` asks the person what to shorten; `cover_sheet_empty` points them to the TPS page; `tweak_exists`, met only on the TPS page, is reported without retrying.
- The store's own refusals, a receipt or user id change, are unavailable-now steps; a correct call never meets them.
- A scope refusal also carries `required_permission`, `read` or `read_write`: what the
  attempted action needed (a save needs `read_write`, anything else `read`), and its
  `next` names that permission.
- Replies add a trial notice if one is due, and that notice can never fail the call. A read or save whose trial gate found no reminder due makes no claim; a replayed save, which never reaches the gate, always tries one.
- Failures return a code and message, and unknown failures say no save outcome is
  confirmed.

## Reads

Files: `server/src/store/compiled.ts`, `server/src/store/memos.ts`.

- `get_cover_sheet` is one statement: whether the account is active, the current cover sheet, the memo and tweak counts and the Keep memos switch. It takes no lock and writes nothing.
- `get_report` is two statements outside a transaction: one loads the account and kind checks, the cover sheet, the kinds, every memo's ranking fields (not its words) and its citations, and every tweak's count; the second records the served report and fetches the chosen finals. A memo forgotten between them is left out.
- `get_report` writes one `served_reports` row (its `report_id` and served tweak ids); no other read writes.
- AI reads are blocked once an account reads as expired, but the person's own web
  view is not.
- An AI read first passes the trial gate, whose statement also checks the account and the intent's kind, so those refuse before the gate; reads open no transaction and take no lock.
- The web view reads no store limits and makes no account check of its own: its
  account lookup and each read require an active account.

## Assembling reports

Files: `server/src/store/memos.ts`.

- A report ranks every memo by requested kind, medium match, word overlap of purpose and audience with the intent (stopwords dropped), tier (your words before steered when overlap ties), full-text rank of the situation (any word) against summary, purpose, audience and final, newest, then id.
- Examples fill by rank: never untouched finals, never finals over 128 KiB, at most 3 steered finals, within a 32 KiB budget; a block that would pass the budget is skipped for the next, and the top one is always served.
- A block's size is counted before its words are fetched, as an upper bound: its header, its words and a `> ` per line.
- Tweaks come from the 10 best-ranked memos that cite any tweak, ordered by their best memo's rank, then citation count, then id, at most 10.
- The text is `# Cover sheet` (when not blank), then `# Examples` (each `## n. kind · medium · tier label · date`, a Situation line, an Audience · Purpose line when known, and the final quoted with `>`), then `# Your tweaks` (one bullet per tweak with its memo count).
- With no example and no tweak, `is_empty` is true and the text ends with a fixed line telling the AI to write from the cover sheet and the request and not to claim to know the person's voice.
- Tier labels in report text are "your words" and "steered by you"; kind labels appear in example headers.
- `TPS.md` is the cover sheet, the tweaks with counts (most cited first), then every memo's final grouped by medium, newest first, each under its kind and date with its summary; first drafts are not in it.

## Memos

Files: `server/src/store/save.ts`, `server/src/store/score.ts`, `server/src/mcp-tools.ts`.

- A memo holds medium, a one-line summary (at most 200 characters), optional audience and purpose (at most 100), an optional kind, mode (`draft` or `edit`; none for writing the person gave), the first draft and its state (`kept`, `missing` or `none`), the final, rounds, the change score, the tier, the `report_id` with the tweak ids it served, the AI (issuer and client), the request ID and its times.
- With `first_draft` or `first_draft_missing`, `mode` and `rounds` (0 to 1000) are required; with neither, the memo is final-only and takes no mode, rounds or tweaks; both together are refused. Shape problems are refused before any database work.
- A final or first draft is non-blank, well formed, has no NUL and is at most 256 KiB.
- Tier at save: final-only and edit memos are `own`; a drafted memo with a kept first draft is `untouched` when the final equals it, else `steered`; with the first draft missing, it is `steered` when rounds is above 0, else `untouched`.
- The change score is normalized token Levenshtein (words and single punctuation marks) from the first draft to the final over the longer token count, from 0 to 1, comparing only the middle after a shared prefix and suffix; it is computed only for a kept first draft and not when that middle exceeds 20 million token pairs.
- A save whose final, first-draft state and first draft match a memo on file returns `unchanged` with that memo, adding nothing.
- `kind_id` must name one of the account's kinds (`invalid_kind`); a memo's `kind_id: null` is read as omitted, before the input is hashed; `new_kind` reuses a kind with that label in any letter case, else creates one; sending both is refused.
- `report_id` must be one of the account's served reports (`invalid_report`); the memo stores that report's served tweak ids.
- With Keep memos off, a memo with a first draft (kept or missing) is refused with `memos_off`; a final-only memo still saves.
- A saved memo's result carries `memo` (`memo_id`, tier, kind, rounds, change to three decimals and its tweaks) and `receipt`: "Kept memo: <kind, or medium without one>, <n rounds, or "your words">, tweaks: <up to three, "; "-joined>", with "and N more" past three.
- `forget_memos` takes 1 to 100 ids and deletes those memos, their citations and every tweak left with none; when none is the account's, it is refused with `invalid_memo`. The result lists the ids forgotten.
- `memo_context` replaces a memo's medium, summary, audience and purpose (an omitted optional field clears) and, when sent, its kind; the words never change. The same context returns `unchanged`; an unknown memo is `invalid_memo`.
- When the instructions say to save (acceptance, untouched finals included) and what to leave out is AI guidance; Milton cannot see the conversation.

## Tweaks

Files: `server/src/store/save.ts`, `server/src/store/score.ts`, `server/src/store/tps.ts`.

- A tweak is one line of at most 200 characters on one account, with the AI and time it came from.
- A memo cites at most 10 tweaks, and only when its final differs from its first draft; tweaks on a memo whose final equals its first draft are refused. An empty `tweaks` list is read as omitted, before the input is hashed.
- `{tweak_id}` must name one of the account's tweaks (`invalid_tweak`).
- `{text}` is normalized (Unicode NFC, lower case, collapsed spaces, trailing punctuation dropped) and reuses the account's tweak with that form, else is added; text of only punctuation is refused. A tweak named twice in one memo is cited once.
- Each memo-and-tweak pair is one citation; a tweak's count is its citations.
- The TPS page deletes a tweak with its citations, or rewords it in place, keeping its id and citations; a wording another tweak already has is refused with `tweak_exists`.

## Cover sheet

Files: `server/src/store/save.ts`, `server/src/store/tps.ts`, `server/src/store/memos.ts`.

- An account has one current cover sheet, at most 1,500 characters. Every change appends a version (from 1) recording whether an AI (its issuer and client) or the person made it; nothing is overwritten.
- `cover_sheet` from an AI carries `expected_version` and either `add` (one line, at most 300 characters) or `remove` (one whole existing line, copied exactly).
- A stale `expected_version` returns `conflict` with the current version and text.
- Adding a line already present is `unchanged`; removing a line not present is `line_not_found`; a removal that would leave it blank is `cover_sheet_empty`.
- A change past 1,500 characters is refused with `cover_sheet_limit`.
- The TPS page's form sends the whole text with the version it showed: line endings become `\n`, trailing whitespace is trimmed, the same fence applies, it may empty the cover sheet, and the same text is `unchanged`.
- The cover sheet is `get_cover_sheet`'s text and the first part of every report.

## Scoreboard

Files: `server/src/store/score.ts`, `server/src/store/tps.ts`.

- The TPS page computes it on read, with no model, from memos with a kept first draft and a change score.
- Draft and edit memos are scored apart.
- Below 10 memos of a mode, it shows only the count.
- From 10, it shows the medians of rounds and change and the share accepted as-is (final equal to the first draft) for the latest 5 against the first 5.
- From 60, it compares the last 30 days with the 30 before.

## Saves

Files: `server/src/store/compiled.ts`, `server/src/store/save.ts`,
`server/src/store/accounts.ts`.

A save runs in one transaction under the account lock: replay or gates, then
the change and the receipt, which commits with its result or not at all.

### Admit

- The input schema is strict, and a save's shape is checked before any database work; those refusals write no receipt.
- Only AIs can call `create_memo`, so a save through the web app's store is refused with
  `assistant_required`.
- Input is hashed, and the same request ID with the same input replays the original
  result.
- The same request ID with different input is refused.
- A concurrent save of the same request waits on the account lock, then replays.
- Trial refusals write no receipt, so the same request can succeed later.
- A request over 256 KiB fails with `request_too_large`, and that decision is stored on the receipt so it replays.
- If the commit's acknowledgment is lost, Milton looks up the receipt under the account
  lock: present, it returns the stored outcome; absent, nothing was written and the
  store error stands. Only when that lookup fails too does it return
  `save_outcome_unknown`.

### Apply

- The change runs after a savepoint; a refusal rolls back to it, so nothing changes and
  the receipt stores the refusal. A transient or unknown database error
  (`store_unavailable`) rolls back the whole save instead, with no receipt, so the same
  request can succeed on retry.
- A memo, its new kind, its new tweaks and its citations are written together.
- The receipt is written last, once, with the outcome.

## First setup

Files: `server/src/store/setup.ts`, `packages/theme/setup-prompt.ts`.

- Setup is served while `get_cover_sheet.is_empty` says the account has no cover sheet and no memos; the AI offers it once, a request to set up Milton accepts it, and a declined offer is not repeated.
- Setup never blocks a writing task, never reads an inbox, connects mail or imports anything the person didn't paste.
- The connection is confirmed only after a successful `get_cover_sheet` read.
- The AI first asks the person to paste about five things they wrote and sent, unedited, saying Milton keeps each as a memo, and saves each as a final-only memo exactly as pasted, with context and a kind, telling them each receipt; only their own writing, skipping automated, forwarded and other people's text and anything holding secrets.
- A writing task the person brings comes first: the AI reads `get_report` for it, saves the memo when they accept the final, then returns to setup.
- Then it offers to start the cover sheet with lines the person gives, in their words, never suggested from their writing.
- Every setup includes the standing instruction: the AI shows it and asks on its own, adding it only after the person agrees, or shows where to paste it.
- The script carries one fictional final-only memo as a JSON example.
- The shared setup prompt (the site widget and the app's empty state) asks the AI to connect, read what is on file, ask first for about five pieces the person wrote and sent and keep each as a memo exactly as pasted, take optional cover sheet lines, show the standing line and add it once the person says yes, help with a writing or clean-up task first if the person would rather, and never wait on any of it.

## Sign-in and accounts

Files: `server/src/auth.tsx`, `server/src/auth-session.tsx`, `server/src/auth-login.tsx`,
`server/src/auth-assistants.tsx`, `server/src/auth-account.tsx`, `server/src/pages.tsx`,
`server/src/billing.tsx`, `server/src/store/index.ts`, `server/src/store/billing.ts`,
`server/scripts/backfill-subscriptions.ts`, `packages/forwarded-client/`.

- Native auth hosts verified password/email, Google/GitHub, consent and account security; own form destinations and direct native URL-encoded browser form POST redirects (including logout confirmation) share an escaped fresh-document Continue navigation under strict same-origin form policy; direct GET, JSON/fetch and machine calls retain native redirects, and finalized native/static/refusal responses use strict-origin referrers (origin only, no paths/queries/proofs, suppressed on HTTPS downgrade) so same-origin form POSTs retain Origin while missing/null/foreign Origins stay refused; responses retain their security headers and native cookies; app never handles passwords or native cookies.
- Auth's wrapper guards read each POST body by its lowercased media type, and native is sent only that type with the body re-serialised from what the guards parsed, so no later decode finds a field the guards missed; a POST that is not exactly `application/json` or `application/x-www-form-urlencoded` (including an empty one with no type, or a combined comma-joined header) gets 415 before any database work.
- A new password (sign-up, reset or change) is 8–128 Unicode characters in both its original and NFKC forms, spaces kept and never truncated, and is refused if it is one repeated character or on the inline or pinned common-password lists; the before-hook refuses it before native reads or spends a reset token, so a refused reset can retry with the same link. New-password fields carry `minlength="8"` so the browser flags a short one first.
- A 4xx refusal of the sign-up, sign-in, reset or change-password form re-renders that same page (status 400, or 429 when rate-limited) with the message in a `role="alert"` paragraph, refilling the typed name, email, sign-in continuation and reset token but never a password; a reset refused for a dead token (`INVALID_TOKEN`), any 5xx (including "could not confirm the outcome") and every other form keep the separate try-again page.
- With both `AUTH_TURNSTILE_SITE_KEY` and `AUTH_TURNSTILE_SECRET_KEY` set (one alone fails startup), email sign-up needs a Cloudflare Turnstile token: only `/signup` loads the widget, and only its CSP adds `https://challenges.cloudflare.com` to `script-src` and `frame-src`; the form forwards the widget's token as `x-captcha-response` (never a browser-sent header), and the wrapper, only for a body with a well-formed email (else 400 before any database work, so the per-email bucket always applies), after the network gate has also taken a 3-in-10-s per-network sign-up bucket (native's own sign-up rule is then off, so that bucket is the only sign-up limit; with Turnstile off native's applies), and outside the native in-flight slots (at most four verifications at once, 5 s each), checks it with siteverify, sending only the secret and token, for host `auth.meetmilton.com` and action `signup`. A missing token is 400; a token Cloudflare calls invalid, expired or reused, or one for another host or action, is 403; `internal-error`, any other or no code, a non-2xx, a network failure or the timeout is a retryable 503 (fail closed), and a fifth concurrent check is 429. A slow or failing Cloudflare stops only email sign-up; sign-in, resends, resets and social sign-up keep their capacity. Without the keys, sign-up needs no token.
- Auth's CSS, favicon and fonts keep every security header but cache like the app's assets (immutable at the versioned URL, otherwise no-cache); every other auth response stays no-store.
- App uses maintained code/S256 OIDC with shared SQL one-use state/nonce/verifier, exact callback, signature/issuer/audience/subject and matching UserInfo/opaque-token proof.
- Identity-only app sessions last at most one absolute hour and never outlive their native opaque token; renewal starts a new SSO flow with no refresh/offline scope.
- An app session row holds the cookie's SHA-256, the native issuer, subject, sid, binding, incarnation, generation and verified email, and its expiry; the native access token is used only within the sign-in request (UserInfo and introspection) and never stored (owner file `013` drops the old column).
- App cookies are host-only Secure/HttpOnly/SameSite=Lax over HTTPS; every use checks the original nonempty sid, immutable binding, incarnation and generation against native SQL, in the statement that reads the session and its identity's active account.
- Invalid proof refuses; actual native5xx/network/timeout is 503; an uncertain spent callback recovers through a new login. Every discovery, token, UserInfo or introspection failure and any discovery metadata mismatch is logged (class and code only); a person declining sign-in (`access_denied`) is not.
- New logins reclaim at most16 expired flows/sessions each; admission correlations expire after24 hours with bounded reclaim, while eligibility/key policy and original operation associations remain indefinitely for their stated purposes. Migrations `0005` and `008` drop the unread `deleted_identities` and legacy mapping tables; rollback is the pre-migration snapshot.
- Forms require same origin, an ASCII CSRF token and unique fields; sign-in rotates CSRF.
- Auth rate limits key each network, for every native request including the account-security page's own session lookups, by the client address Google's load balancer appends (second-to-last `X-Forwarded-For` entry, IPv4-mapped IPv6 as IPv4, other IPv6 by /64, never the first entry; else the socket peer): one statement first takes the 120-a-minute network gate (for a request proven to be the app, by its client secret or its own access token against native's stored hash, the token only while native would accept it and its binding is current, a 1,000-a-minute app ceiling instead) and, only if it admits, 10 a minute per account email and, except for the app, 60 token and 30 revoke requests a minute per client and network and 60 UserInfo requests a minute per bearer token and network, so a refused request creates or charges no other bucket; Better Auth's per-network-and-path 3 sign-in/sign-up/change-password attempts per 10 seconds, 3 mail requests, 30 authorize and 20 registration requests a minute are each one atomic `take_rate` call; every bucket is an HMAC'd key in `milton_guard.rate_bucket`.
- Auth runtime and owner command pools always verify PostgreSQL TLS certificates/hostnames, even with mode omitted; unsafe/libpq/duplicate URL settings refuse.
- Every native generation advance or deletion atomically retires older reset proofs; issuance takes the original user snapshot under the same parent lock, never the redemption-time generation.
- Native unlink awaits `milton-admit`'s eligibility preservation before taking its parent lock; it uses guarded original metadata and stores fingerprints for existing writing accounts only, without billing or admission.
- Native mail callbacks capture one original message; every generic signup/reset/resend success commits the same encrypted-job or no-op receipt outside native swallowing, with no provider I/O during HTTP; failure is uncertain/retryable503. A message to a reserved `.invalid` address is never queued: it commits the no-op receipt an unknown address gets, so the answer is the same and delivery has nothing to send. Nor is one to a domain DNS says takes no mail (a null MX, NXDOMAIN, or no MX and no A/AAAA); the domain is looked up before queuing whether or not a message was captured, within about 2 s and after giving back the request's native in-flight slot, and a timeout, SERVFAIL or other resolver error sends anyway; a skip logs `auth_mail_skipped` with the kind and a 12-hex SHA-256 digest of the domain, never the address. Each address (lowercased, keyed by HMAC, not by account, so a sign-up's first message counts and a recreated account starts no fresh count) gets at most 3 queued messages of a kind an hour in a fixed `take_rate` window, whatever networks ask; every sign-up, resend and reset answer runs the same statements (one bucket take, then the receipt): a message about to be queued takes its address's bucket, and an outcome that sends nothing takes one shared stand-in bucket, so asking for nothing never spends an address's allowance; a capped message commits the no-op receipt and logs `auth_mail_skipped` with reason `account_cap` and the kind only.
- Every auth message replies to `AUTH_MAIL_REPLY_TO` (default `support@meetmilton.com`, validated as one address) through Resend's `reply_to`, bound into the encrypted message like the sender; the plain-text body is unchanged.
- Auth-only mail functions lease one original message at a time for bounded delivery, stable job-id idempotency, finite retries and shared Retry-After pause capped at24 hours by worker and SQL across passes; native authority never rebinds to a later email owner.
- Native capture checks its one-hour lifetime on the native clock; SQL accepts only finite future proof expiry and caps mail delivery at native expiry or15 minutes; terminal transitions clear payloads and bounded owner maintenance clears expired/fenced payloads and receipts eligible after24 hours, with physical retention longer if maintenance is delayed.
- Bootstrap000 validates an explicit complete retained-login CONNECT/audited TEMP inventory before transactional pregrants/PUBLIC revocation; missing or inconsistent inventory refuses without partial privilege loss.
- Authenticated native admission carries exact issuer/subject/continuation and native-validated verified email and bounded Google/GitHub IDs, including [] for password-only. Each authorize or consent accept asks the app once, though native asks twice: a second ask with the same admission inputs shares the first's outcome, a refusal included, and still runs its own `bind_flow`, so a session or binding that ends between the two is refused; nothing carries to another request. The auth service waits 5 s, ID token fetch included, for `milton-admit`'s admission; revisit that when billing is turned on, since the app's worst case with Stripe is about 15 s.
- Admission (`milton-admit`, on the app's database login) checks the dedicated eligibility-key policy, then creates/finds one stable internal m_* account and trial and applies existing subscription admission; untrusted/invalid handoffs cause no mapping or billing effects.
- Ownership uses exact issuer+subject, never email, provider nickname or eligibility fingerprints; native linking never merges writing or restarts a trial.
- Account creation's unique identity row and billing's row lock converge under retries/concurrency; a new account starts empty.
- Email and stable social identities get keyed trial-eligibility fingerprints with a dedicated stable key and first claimant, retained after deletion; changed/unprovisioned keys refuse admission. They are the only second-trial block: a new account sharing one with an earlier account starts canceled, whether trials are on or off.
- A trial row with no status gets the existing 30-day Stripe trial when billing is configured; no row/status or billing disabled calls no Stripe API.
- Subscription creation locks the trial row across customer/list/create; minute-based idempotency retains the known remote-success/local-timeout ambiguity across a minute boundary.
- Billing failures stop admission with retryable503; existing Stripe state is listed/reconciled before another create. An admission for an account whose deletion has begun answers 410, and native refuses that sign-in, consent or explicit link with 403 `account_deleting`, not a retry; native's own identity read already refuses one that starts after the deletion begins.
- Owner-only `server/scripts/test-account.ts` provisions the fictional end-to-end account (`e2e@milton-test.invalid`): its Milton account, created first by the owner marked `test_account` and with no trial row and bound to a pre-chosen native id, so sign-in, checkout and the backfill never call Stripe for it; then the native user with a verified `.invalid` email and a random password, created last and without queuing any mail, so nobody can sign in to an unmarked account; a browser sign-in; and a 365-day read-and-save key minted through the app's form. It writes the three values to a new mode-0600 env file and refuses an existing email or file and any address outside `.invalid`, before any write; after a failure, `--resume` with the same file converges on the marked account, verifying it before signing in.
- The subscription backfill remains an owner-selected dry run by default and never gives returning deleted identities another trial; it skips test accounts entirely (not counted, no Stripe call).
- Its `--resync` mode, for after a release whose old and new revisions overlapped, re-reads every stored customer of a non-test account from Stripe through the webhook's read and compare-and-set (no event), with the same dry-run default, live-key guard, pacing and counts-only output; a failed read or second conflict counts as failed and exits nonzero.
- Account security routes to native UI; destructive deletion requires authoritative native freshness, exact typed confirmation and retention of current guarded verified-identity fingerprints.
- App persists lifecycle UUID, original account/subject/incarnation/client and requester association before first native/remote attempt; retries never select current/recreated targets.
- Disconnect commits native original-binding refusal before bounded cleanup; a failed or unfinished step answers 503 with a retry page re-posting the same operation, as deletion does; reconnect creates a new binding and never revives an old token.
- Native UserInfo answers only while the token's binding is live, the same `binding_status` check MCP and the app make on every call: after the rate gate the auth wrapper reads a JWT's binding, subject, client (`azp`), scopes, incarnation and generation (native then verifies its signature) or looks an opaque token up by its stored hash; a missing, revoked or superseded binding gets 401 `invalid_token` with no claims and native is not called, a database failure 503, so a disconnect or a begun deletion ends an AI token's UserInfo at once rather than at its expiry.
- Deletion saves the current verified-identity fingerprints as it starts, then commits refusal, then Stripe cancellation, then writing erasure (which records no identity of its own), and finally bounded native cleanup; unknown inventory/cascade shape leaves a retryable incomplete operation.
- Native cleanup deletes the account's sign-in grant bindings in the same step as the native user, after its codes, tokens, consents, sessions and sign-in methods (at most 256 rows, the per-user cap `bind_flow` enforces), so no partial run leaves a user or credential without its binding; every code, token, session or consent that named a missing binding is refused (each gate looks the binding up strictly), and the deletion record keeps `bind_flow` from making a new one.
- Consenting to an anonymous AI registration writes a durable link from the account to it (`milton_guard.client_link`, native 008); disconnects, token and consent purges and binding expiry leave it, and the native user cannot be deleted while it exists. Deletion takes each link under the registration's lock: a registration no other account is linked to is deleted with its dependents, and one that is keeps working for them with its name and contacts cleared. Either way the SHA-256 of its client ID goes into `milton_guard.cleared_client` (no foreign key, kept indefinitely), and a trigger empties name and contacts on any later insert or update under that client ID, so neither a metadata-document refresh nor a rediscovered registration brings them back. Neither Milton nor its pages show a client name (consent shows the client ID, Connected AIs its host), so a cleared one changes no page. Native 008 backfills links from existing consents, consented bindings and native's disconnect records, each matched to the user's recorded identity incarnation; a record for another incarnation counts as a deleted original identity's. It applies the same rule to registrations a deleted identity's remaining binding or disconnect record names, then drops deleted identities' unreferenced bindings. It first locks every runtime table it writes in one statement that never waits (55P03 if any is in use; run it again), so no service transaction or cleanup can deadlock with it; it can still wait on another owner session (the ledger, owner DDL), which the runbook rules out. Writes to those tables wait until it commits. Kept indefinitely: registrations no account ever authorized, and ones whose only authorization before 008 left no consent, binding or disconnect record (revoked by the AI or left to expire, then pruned); `public.assistant_disconnects` has had no writer since native auth, so it names no native registration.
- Writing and original-incarnation app credentials are never erased before Stripe cancellation succeeds; incomplete deletion never claims completion.
- Native refusal and the progress billing reads commit in one transaction. Once they do, nothing links a Stripe customer to the account (the link reads the deletion while holding the billing row); a customer Stripe made for a refused link is deleted at Stripe straight away, best effort (a failure is only logged), unless the row already holds it under the same idempotency key, when it is the deletion's to end. Stripe cancellation reads the customer holding that same row, so it waits for an enrolment in flight, and the erase ends any customer still linked, holding the row, before erasing, so an account is never erased with a live customer. Checkout reads the deletion again once its session is open, a finished deletion and an erased account included, and expires it (best effort) with a 409; a deletion that begins after that read still deletes the customer, and whether Stripe then refuses to complete the open session is not verified at Stripe.
- Browser logout removes local authority and navigates through fixed-client native RP logout with exact return and native confirmation, leaving offline AI grants independent; "Switch account" adds the one fixed logout `state` native echoes back, and only that exact single value sends the signed-out return on to a fresh sign-in (`prompt=login`).

## Web app

Files: `server/src/pages.tsx`, `server/src/memo-pages.tsx`, `server/src/store/tps.ts`,
`server/src/auth.tsx`, `server/src/auth-session.tsx`, `server/src/auth-assistants.tsx`.

- Pages run no scripts, under a strict CSP, and are not cached; they link content-versioned assets and preload Geist and the Latin JetBrains Mono subset.
- A page route that fails shows "Unable to continue" at the error's status, with a link back
  where one applies.
- An unknown error there reads as a 503 and is logged.
- The home page shows a marketing page signed out and the TPS page signed in.
- `/tps-report` shows the same TPS page as the signed-in home page.
- The TPS page reads in one statement: the cover sheet and its version, the Keep memos switch, the newest 200 memos, every tweak with its count (most cited first) and the scoreboard.
- Each listed memo shows its time, AI, medium, kind, summary, audience, purpose, mode, rounds, change, tier, the tweaks its report served (those still on file) and the tweaks it taught; its first draft and final load only when that memo is opened.
- `/tps/memo/<id>` shows one memo in full (first draft or why there is none, final, context, served and taught tweaks, Forget); another account's or an unknown id is a 404.
- `/account/memos` holds the Keep memos switch; "Delete all memos" asks on its own page (`/account/memos/delete`) and runs only with the confirming field.
- Every TPS page change is a POST with the CSRF and Origin checks, then redirects back with a notice.
- Every TPS page change runs in its own transaction under the account lock: the cover sheet form, forgetting one memo, Delete all memos (every memo, tweak and kind, not the cover sheet), deleting or rewording a tweak, and the Keep memos switch.
- Each view makes one structured read; a failed read fails the page, with no plain-text fallback.
- `/download` returns the complete writing export as `TPS.md`, including when AI access is paused.
- `/assistants` lists bounded live native connections grouped by client and read/write access, and original incomplete disconnects; a full native page explicitly reports incomplete listing.
- `/assistants` also lists every active connection key (name, access, created, last used, expiry; never-expiring keys say "Never expires"; keys a security change stopped say so), then under "Expired keys" the 20 most recently expired, never a secret or hash.
- Creating a key takes a name (1–60 characters, one line), Read only (default) or Read and save, and 30, 90 (default) or 365 days or Never; it needs the form's CSRF/Origin checks and a sign-in within 5 minutes.
- An account can have 20 active (unrevoked, unexpired) keys; creation takes the account lock so the cap holds.
- Under that lock, creation asks native SQL that the session's snapshot is still current (otherwise "Sign in again") and revokes this identity's active keys bound to any earlier snapshot, which can never work again.
- The created key is shown once, with a Claude Code command, on a no-store page; only its hash is stored.
- Revoking asks on a separate page with a plain form, revokes one key, and the key is refused from its next request; both look the key up by id and owning account, independent of the list.
- The setup prompt changes depending on whether the account is empty.
- Account opens a native popover; Escape closes it and returns focus to Account, and
  clicking outside closes it.
- With billing configured, the account menu on every signed-in page offers Add a card in a
  trial, Subscribe when expired, and Manage billing when paid; early access shows nothing.
- If the status read fails, the page still renders, with no billing item.
- A note above the TPS page shows only in a trial's last 7 days or when expired, with the same
  button; it shows nothing when paid or earlier in a trial.
- Without billing configured there are no buttons.

## Limits and trials

Files: `server/src/store/index.ts`, `server/src/store/trials.ts`,
`server/src/store/billing.ts`, `server/src/billing.tsx`, `server/src/config.ts`.

- Limits live in a single `store_config` row and are validated on read; invalid limits refuse every MCP call and sign-in, but no memo bound reads them.
- Memo bounds are fixed in code: a 256 KiB request, finals and first drafts up to 256 KiB, a 1,500-character cover sheet, 200-character summaries and tweaks, 10 tweaks per memo and 100 memos forgotten per save.
- Trials are switched by `trials_enabled`, and when off, everyone is early access.
- With trials on, access follows the Stripe subscription status held on the trial row:
  trialing reads as trial, active as paid, and past_due as paid for 3 days from the renewal.
- Past that grace, canceled, unpaid, incomplete, incomplete_expired, and paused read as
  expired.
- No row, no status, or a status Milton does not know reads as early access, so a Stripe
  outage never cuts off a connected AI, and reads never call Stripe.
- A test account (`users.test_account`) is permanently exempt from trials and billing,
  checked explicitly on each path: it always reads as early access, sign-in starts no
  subscription for it, checkout and the portal answer 409, no path gives it a trial row or
  status, the webhook never writes its row and no trial notice is offered.
- A trial notice is claimed once per stage, 7 days and 1 day before `trial_end`, only
  while trialing, and carries the one link, the signed-in app home.
- Expired accounts are blocked for AIs with a refusal carrying that link, while the
  web view and download stay open.
- The three Stripe settings are all or nothing: any one set means all three must be valid,
  or the app fails at startup.
- With billing unset, both billing routes and a POST to the webhook answer 503.
- Every Stripe call uses a pinned API version and a 5-second timeout, through Milton's own
  fetch client rather than the Stripe SDK, which keys and retries POSTs on its own.
- Only the app service routes `/billing/webhook`, ahead of the browser pages, so no session,
  cookie, or CSRF check reaches it.
- The webhook takes only POST with a JSON body, and a signature more than 5 minutes old
  fails.
- The Stripe webhook verifies the signature with the official `stripe` package, then takes
  only a customer ID from the six handled event types, because Stripe does not guarantee
  event order.
- A handled event Milton cannot parse gets a 400 unrecorded, so Stripe retries it.
- For a customer Milton holds, the webhook reads the customer's subscriptions from Stripe
  with no transaction open, then writes the deciding one where it records the event, only
  if the row's `stripe_revision`, which every write of the Stripe state by Milton's code advances even with
  unchanged values, is what it was before the read, so an older read never lands over a
  newer one; on a change it reads once more, and a second change answers 503 unrecorded.
- The deciding subscription is active, then trialing, then past_due, otherwise the newest.
- Only a successful empty list with a stored subscription writes canceled.
- Any non-2xx from Stripe's list, 404 included, is a failed read: the webhook answers 503
  unrecorded so Stripe retries, and sign-in stops with try again.
- A replayed event, an unknown type, or a customer Milton does not hold calls nothing.
- Both billing routes take only signed-in POST forms with the CSRF check.
- `/billing/checkout` answers 409 to an account with no trial row.
- Once an account's deletion has begun, both billing routes answer 409 before any Stripe
  call, and enrolment refuses it with 409 `account_deleting`, not try again, whether
  the deletion began before or during it; the backfill counts it as skipped. Billing
  reads the deletion from the lifecycle row, which outlives the erase, and reads an
  account that is gone as being deleted.
- `/billing/checkout` sends trialing, active, past_due, unpaid, and paused to the Stripe
  portal.
- With a stored customer, it lists Stripe first, with no transaction open, and goes to the
  portal if any such subscription exists, storing it as the webhook does (over an unchanged
  revision, one re-read, then 503); an empty answer is checked against the revision too, so
  a late webhook or a write during the read cannot sell a second subscription.
- An account still waiting on its trial takes it first, then the portal, or a 503 if it did
  not start, so paying early cannot lose the 30 days.
- Any other status gets Checkout in subscription mode, card required, no trial; each
  session expires after 31 minutes (Stripe's 30-minute minimum plus a minute), not 24 hours.
- `/billing/portal` sends an account with a stored customer to the Stripe portal, and
  answers 409 without one.
- Before sending anyone to Stripe, both routes copy the sign-in email to a stored customer
  (Checkout before it creates its session, the portal while it creates its own), so a
  backfilled customer gets one before it can add a card; a failed copy is logged and never
  stops anyone paying.
- Both routes leave through a page that navigates, because `form-action 'self'` blocks an
  external redirect after a form.
- A Stripe session URL is used only if it starts with Stripe's checkout or portal host.

## Database guarantees

Files: `server/drizzle/`, `server/src/store/schema.ts`, `server/src/store/database.ts`.

- The memo tables (0012) check each column's shape: medium, one-line summary, audience and purpose; the first-draft state matching the first draft and mode; non-blank words up to 256 KiB; rounds 0 to 1000; change 0 to 1; the tier; and at most 10 served tweaks, only with a report id. Kind labels are unique per account in any letter case, tweak forms unique per account, and cover sheet versions positive and at most 1,500 characters.
- Owner file `014-memos-roles.sql` lets MCP insert, read and delete memos and update only their context columns, insert kinds, served reports and cover sheet versions, insert and delete tweaks and citations, and read the Keep memos switch; app reads them, deletes memos, kinds, citations and tweaks, rewords tweaks, appends cover sheet versions and sets the switch. Neither can change a memo's words.
- Account erasure cascades every memo, kind, tweak, citation, served report, cover sheet version and switch row.
- 0013 drops the old writing tables (cards, card versions, accepted changes, sample kinds, samples, sample versions and the guide tables) with their guards and sequence, and deletes the old store's save receipts, told apart by their outcome's shape; every receipt the memo code wrote stays, so a replay still returns its stored outcome. Owner file `015-drop-guide-roles.sql`, applied before 0013, drops the guide roles.
- 0014 drops `save_requests.source_hash`, unread and unwritten since #45; a receipt holds the account, request id, input hash, outcome and time, and `save_request_hashes` checks the input hash's form.
- A receipt is written once with its outcome and cannot change.
- History has no size cap. History rows never shrink short of account deletion, so the
  lifetime cap that refused every save once an account reached it is gone (0030), with
  the `retained_bytes` counter it read; 0006 drops the generated `payload_bytes` columns
  it summed.
- User IDs cannot change.
- `trial_accounts.stripe_revision` (0011, bigint, default 0) advances on every write of the Stripe state columns by Milton's code; app's table-wide grant on `trial_accounts` (005) covers it, and MCP's column list leaves it out.
- `users.test_account` (0009, default false) marks the fictional end-to-end check account; owner file `011-test-account-roles.sql` narrows app's INSERT on `users` to its other columns, so no runtime login can set it, and usage and metric counts exclude it.
- Disconnects and identity hashes have no foreign key to users, so they outlive the account.
- `docs/deletion-inventory.txt` classifies every text-bearing column the three migration tracks create as deleted by account deletion, hidden (kept, never served), retained (tied to no account, so deletion cannot remove it) or not personal; a test on a fresh schema fails on any column missing from it.
- `connection_keys` (0004) cascades from users and from its (issuer, subject) identity, requires the native binding (issuer, subject, incarnation, generation), checks id, hash, name, scope, binding lengths and dates, and grants nothing to the legacy writing group; owner file `006-connection-keys-roles.sql` lets app read every column but the hash (binding included), insert and set `revoked_at`, and MCP read and set `last_used_at` only.
- Native 007 adds only `milton_guard.connection_key_status(subject, incarnation, generation)`: SECURITY DEFINER, fixed `pg_catalog, pg_temp` path, false on NULL or any mismatch, no PUBLIC/auth/guide EXECUTE and no table grants; MCP and app may execute it. Without it, every key is refused.
- The native auth migrator applies each migration file and its ledger row in one transaction under an advisory lock, so a crash leaves both or neither; a file that commits or rolls back the transaction itself fails after running and gets no ledger row.
- `stripe_events` keeps each event's ID, type, and body hash, never the payload.
- Fresh installs use one Drizzle baseline; a populated older database refuses it.
- Distinct app/MCP roles have explicit writing grants, no inherited owner/group/DDL/TEMP privileges and no native secret reads; app-only session/flow/lifecycle/eligibility storage is denied to MCP/auth.
- The runtime role can read and lock the `store_config` row but cannot change its settings.
- PostgreSQL connection, query, transaction-control and close failures become store errors: known triggers and constraints get clean coded responses, unknown failures log only class/code, and callback errors survive rollback/close unchanged.
- The store opens only a database named `milton`, over TLS.
- Runtime queries borrow bounded direct PostgreSQL TLS connections from one process pool per URL (at most 40, waiting at most 5 s for one); a connection idle over 30 s by the wall clock, whose last command, BEGIN, COMMIT or ROLLBACK failed, or with a query or transaction unfinished when its operation ends, is closed instead of reused, and that operation's later calls refuse; transactions keep one connection; the server's 20 s statement and 10 s lock limits come from the app/MCP role settings (`007-role-timeouts`), since Neon drops the same options passed at connect; app/MCP close the pools on SIGTERM after in-flight requests.
- A signed-in page runs its independent reads at once, each borrowing its own connection (at most 4 per request, on `/assistants`); no operation borrows while holding one, so a full pool makes reads wait, never deadlock.

## Static site

Files: `apps/site/`.

- Astro builds static pages and copies shared fonts from the theme.
- Every static page, including 404, shows the same shared footer navigation.
- `/for-agents` serves a static product briefing, alternatives, the three tools, when memos are saved, export, price, evidence limits and an optional first writing task in the initial HTML.
- The hero demo shows one fictional cleanup request with illustrative plain-AI and
  Milton outputs; build-time ordered word matching computes words kept from the
  displayed strings, ignoring case and punctuation except normalized internal
  apostrophes, and unmatched output words stay underlined. One 10,500 ms clock sweeps
  a paper tint over edits with two 2,150 ms reading holds; all text and scores remain
  readable throughout, with no playback controls or status announcements.
- Playback waits for 35% card visibility, or 80% of the maximum visible card area when a
  short viewport cannot show 35%; resizing updates that threshold, and playback pauses
  off-screen or in a hidden tab, preserving its position.
- Reduced motion or disabled JavaScript shows the complete illustration without animation.
- The setup widget copies a prompt, falls back to manual selection, and closes on Escape
  or an outside click.
- The fake crowdfunding campaign on `/pricing` is static data.
- `/research` presents the approved testing notes, linked from About and the site footer.
  `/notes` is retired with no redirect or alias, so old URLs reach the normal 404.
- Every page loads Vercel Analytics.

## Theme, scripts, and CI

Files: `packages/theme/`, `server/scripts/`, `scripts/check-migrations.ts`,
`scripts/agent-docs.ts`, `server/test/copy-drift.test.ts`, `.github/workflows/checks.yml`.

- A shared theme supplies fonts, favicons, and tokens, with a WCAG contrast test. App and auth text outside the Latin JetBrains Mono subset fetches the full master on demand, which also renders a non-Latin letter with its combining mark; the site serves only the subset.
- `migrate.ts` applies writing migrations only as neondb_owner; explicit --app-auth applies app-only migration005 after native004 as an approved app migration owner, with no runtime startup migration.
- It takes the owner connection from `MILTON_OWNER_DATABASE_URL` for a release, otherwise
  from `server/.dev.vars`, and never from an inherited `DATABASE_URL`.
- `check-mcp` holds the SDK client check `mcp.test.ts` runs: the instructions, exactly three tools, and a read, without saving.
- The isolated check-auth-integration builds actual product modules with production minification under Node26/PG18 and mocks only external boundaries.
- `check-runtime-role` audits selected NOINHERIT app/MCP roles, ownership, DDL/TEMP, native/app credential/function boundaries and the role's own 20 s statement / 10 s lock timeouts.
- `probe-forms` confirms a signed-out form post passes CSRF.
- `e2e.ts` checks a deployment end to end on the test account only: a browser sign-in (following redirects, Continue pages and native's JSON redirects, which native sends because Node's fetch always says `Sec-Fetch-Mode: cors`, only to the app and auth origins) that must show the account and list the key's public id before the key is sent anywhere, an MCP connection with that key listing exactly the three tools, then a gate before any write (no cover sheet, no tweaks, and at most 5 memos, every one this check's own: kind `e2e check`, your words), forgetting those leftovers, an empty baseline, a marked fictional final-only memo saved (tier `own`, receipt `Kept memo: e2e check, your words.`), read fresh by a new session with its summary and quoted final as the only example, forgotten, and a final read equal to the baseline (empty, same cover sheet version, no memos, tweaks or examples). One JSON line per step with no secret or memo text; a key under 30 days from expiry warns; exit 0 only when every step passes, and 1 for a refusal, a failed step, a crash or a run past 240 s.
- `build.ts` builds the CSS with Vite, versions the public assets by content hash, and bundles the Cloud Run and end-to-end check (`e2e.js`, the `milton-e2e-daily` job) entries with Bun, minified except identifiers, with source maps the image leaves out.
- `dev.ts` serves the app on loopback and rebuilds the CSS on change.
- CI runs the migration guards, the concept docs check, types, tests, formatting, and both integration suites on PostgreSQL 18, holds no secrets, and does not deploy.
- `check-migrations` compares with main: a new migration is numbered above main's highest in its track with its own number, Drizzle journal entries run in order with strictly increasing `when`, every migration file and snapshot matches its hash in `scripts/released-migrations.sha256` (main's never change), and a new drop, truncate or rename of a table, column, view, schema, type or function names its merged code-stopped-by PR (comments and strings skipped; a `DO` block, `EXECUTE` (top level or in a function body), or a function body that drops, truncates or renames, needs that or a `no-drop-or-rename` reason). Without origin/main it checks only the lock and journal; in CI that fails.
- The retired-words check fails, listing file:line, when the site, the consent screen, the app's pages, README, TODO or AGENTS say a word memos replaced (`list_reports`, exact edits, instruction cards, writing rules, samples) or "assistant"; identifiers and keys pass, and lines between `retired-words: off` and `retired-words: on` markers are historical and skipped.
- `packages/theme/facts.ts` holds the standing line, the 30-day trial and the $5.01 price: the setup script, the setup page and Stripe's trial read them, and the shared-facts check fails when README lacks the standing line or a site page or app page states another trial length or price.
- `agent-docs check` runs in CI (`scripts/agent-docs.ts`, vendored by `agent-docs install`) and fails on invalid concept frontmatter, an AGENTS.md index that does not match `docs/`, a Markdown link from a tracked Markdown file into `.agents/tmp`, or drift: a change to code a concept file covers without a change to that file, unless a `Docs-unchanged: <concept>: <reason>` commit trailer excuses it.
- The no-tmp-links test is stricter than agent-docs: it fails when any tracked text file, of any size, mentions `.agents/tmp`, except one known mention with its reason.
