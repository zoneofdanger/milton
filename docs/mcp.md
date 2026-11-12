---
name: mcp
description: An MCP call from token or key to tool result, the three tools and their arguments, outcomes and next steps, and the served-text contract
type: behaviour
covers:
  - server/src/handler.ts
  - server/src/token.ts
  - server/src/mcp.ts
  - server/src/mcp-tools.ts
  - server/src/mcp-outcomes.ts
  - server/src/auth-authority.ts
  - server/src/store/connection-keys.ts
  - server/src/store/index.ts
  - server/src/http.ts
  - packages/forwarded-client/**
  - server/scripts/check-mcp.ts
  - server/test/mcp.test.ts
  - server/test/served-budget.test.ts
  - server/deploy/mcp.service.json
  - apps/auth/migrations/007-connection-key-status.up.sql
---

# MCP

What the tools do with a memo, a report or the cover sheet is in [memos](memos.md),
[reports](reports.md), [saves](saves.md) and [setup](setup.md). This file covers the
call itself and the text AIs are served.

## Transport

- Only POST and OPTIONS pass.
- Origin is deliberately not checked, so web clients reach auth from any origin. The Host
  check stops DNS rebinding and tokens authenticate every call, but this departs from the
  MCP spec's rule that servers validate Origin.
- Each request builds a fresh stateless MCP server, with no sessions or subscriptions.
- The request body bound (256 KiB) is in [hosting](hosting.md); over it, MCP answers 413
  with `request_too_large` and its next step.

## Tokens

- JOSE checks EdDSA `at+jwt` against the exact configured issuer and MCP audience;
  native's fixed implicit UserInfo audience is allowed only with `openid`, and JWKS keys
  cache for 10 minutes.
- Tokens require matching `client_id`/`azp`, supported scopes and the original
  binding, incarnation and generation; ID and session JWTs and confirmation/DPoP are
  refused.
- Every call checks live, immutable native binding status in the statement that looks
  up the account; invalid or inactive is 401, a real status or key outage is 503, with no
  stale-positive fallback. A bad binding refuses before scope, and scope before the
  account.
- Both reads require `milton:read`; `create_memo` requires read and write, including
  direct calls. Read grants list two tools; write grants list three.
- A bad token gets a 401 whose `WWW-Authenticate` points the client to the sign-in
  metadata.
- Each request looks up the active writing account by exact verified issuer and subject
  (a key's lookup requires it too); MCP never provisions an account. That lookup is the
  request's account check, so the store is built without a query and `initialize`,
  `tools/list` and notifications make no store query; each tool call's read and save
  check the account again.

## Connection keys

How a person creates and revokes keys is in [accounts](accounts.md).

- A Bearer value starting with `mk_` is a connection key; every other value takes the
  native token path unchanged.
- A key must be exactly `mk_` + 22-character id + `_` + 43-character secret in canonical
  base64url; it is looked up by id and its secret's SHA-256 compared in constant time.
- Every key call asks native `milton_guard.connection_key_status` (native 007) whether
  the key's binding is still current, the native user verified and no deletion begun; a
  recovery, credential or method change, or a begun deletion stops the key for good,
  even while the writing account is still active.
- A malformed, unknown, wrong, revoked or expired key, one whose account is not active,
  or one whose native binding is no longer current gets the same 401 and challenge as a
  bad token, with no reason; a failed status lookup is a 503, never an acceptance.
- Before any database access, a process limits each source to a 5-token bucket refilled
  at 10 a minute, in a 10,000-source LRU. The source is the client address Google's load
  balancer appends as the second-to-last `X-Forwarded-For` entry (IPv4-mapped IPv6 as
  IPv4, other IPv6 by /64, else one shared `unknown` source; never the first entry). A
  lookup reserves a token, a failure keeps it, a success is refunded to 0.1, and an empty
  bucket gets 429 with `Retry-After` without a slot.
- Each source runs at most 3 key lookups at once, however far its bucket refills; a 4th
  gets 429 with `Retry-After: 1` without a slot. These counts sit outside the bucket LRU,
  so eviction never forgets a running lookup.
- At most 8 key lookups run at once in a process; beyond that, a quick 503 with
  `Retry-After: 1`.
- These limits are per instance, and MCP runs at most 3 instances.
- A read key lists two tools and is refused `create_memo` (403); a read-and-save key
  lists three. Key saves are attributed to the key's id.
- Keys pass the same trial and billing gates as OAuth calls.
- A key's last use is recorded at most once a minute; failing to record it never fails
  the call.
- Tool-call logs for key calls carry the key's public id, never its secret.

## The three tools

- Exactly three tools: `get_cover_sheet`, `get_report` and `create_memo`.
- `get_cover_sheet` takes no arguments and refuses any argument it is sent. It returns
  `text` (the cover sheet), `version` (an integer, 0 before any), `memos` and `tweaks`
  (counts), `keep_memos` and `is_empty` (no cover sheet text and no memos), plus the
  setup script in `setup` while empty; a read-only connection gets a `permission` line
  instead of `setup`.
- `get_report` requires `intent`: `situation` (one line, at most 200 characters),
  `medium` (`email`, `chat`, `post`, `document` or `speech`), `audience` and `purpose`
  (one line, at most 100 characters each, required because vague intents rank worse)
  and an optional `kind_id`.
- `get_report` returns `report_id`, `text`, `is_empty`, `examples`
  (`{memo_id, kind_id?, kind?, medium, tier, date}` in served order), `tweaks`
  (`{tweak_id, text, memos}`) and `kinds` (every kind on the account as
  `{kind_id, kind}`, by label).
- A `get_report` with no intent is refused with what to send and a reconnect hint; a
  malformed intent is refused with each limit it broke and no hint. Nothing is read
  either way.
- A `kind_id` the account does not have is refused (`invalid_kind`) without creating a
  kind.
- `create_memo` takes a UUID `request_id` and exactly one of `memo`, `cover_sheet`,
  `forget_memos` or `memo_context`; `memo.report_id` names the `get_report` read before
  the draft, `memo.tweaks` is the released list (at most 10 items, three distinct) and
  `memo.request` carries the person's ask ([memos](memos.md#the-request)). What each
  change does is in [memos](memos.md) and [deletion](deletion.md).
- `create_memo` returns `saved`, `unchanged`, `conflict` or `failed`, with the request
  ID. `saved` confirms a committed write; `unchanged` confirms no write was needed. A
  memo with a kept first draft adds `changes: {state, found}`, code's own count
  ([memos](memos.md#changes)).
- A read-only connection lists no `create_memo`; a direct call to it is refused with
  `insufficient_scope` and `required_permission: read_write`.

## Argument repair

- Some clients send a nested object as a JSON string. For `get_report`'s `intent` and
  `create_memo`'s `memo`, `cover_sheet` and `memo_context`, a string that parses to a
  plain object is read as that object; any other string meets the schema's refusal.
- A `create_memo` whose `memo` is plain text (not JSON) with only memo fields beside it
  is read as `memo: {final: that text, ...those fields}`, before validation and
  hashing, so either shape is one request (#85).
- A `memo` string that is JSON but not an object, a plain-text `memo` beside `final`,
  another change or an unknown argument, and memo fields beside an object `memo` are
  refused (`invalid_input`) with how to send it. So is a flattened memo still malformed
  once read as nested, naming what is malformed.

## Outcomes and next steps

- Every error result and every MCP HTTP refusal body (invalid token, scope, rate and busy
  limits, oversized request, outage) keeps `error` and `message` and adds `code` (the
  `error`, or `version_conflict` for a stale-version conflict) and `next`:
  `{action, text}`.
- The action is one of `retry` (repeat the identical call, a save with its request ID),
  `reread` (read again, then save with a new request ID), `fix_input`, `ask_user` or
  `tell_user`. The mapping is one table, `nextSteps` in `mcp-outcomes.ts`; a test checks
  every code in the source has an entry, and an unknown code gets the
  unexpected-failure step. A memo refusal with a `field` takes that field's step when
  the table has one: `invalid_input.request` (send only what the person typed, or leave
  request out, and the rest unchanged) and `invalid_input.tweaks` (keep the three most
  likely to recur, and the rest unchanged).
- The SDK's plain-text argument refusals become such bodies, `invalid_arguments` with
  the SDK's text as `message`.
- Memo codes get their own steps: `request_too_large` resaves the memo with the final
  alone (`first_draft_missing`); `memos_off` stops saving drafts, saving only writing
  the person asks to remember; `invalid_kind`, `invalid_tweak`, `invalid_memo` and
  `line_not_found` reread for a valid id or the exact line; `invalid_report` sends the
  latest `report_id` or none; `cover_sheet_limit` asks the person what to shorten;
  `tweak_exists`, met only on the TPS page, is reported without retrying.
- The store's own refusals, a receipt or user id change, are unavailable-now steps; a
  correct call never meets them.
- A scope refusal also carries `required_permission`, `read` or `read_write`: what the
  attempted action needed (a save needs `read_write`, anything else `read`), and its
  `next` names that permission.
- Failures return a code and message, and unknown failures say no save outcome is
  confirmed.
- Replies add a trial notice when one is due ([billing](billing.md)), and that notice can
  never fail the call.

## Logging

- Each call logs the tool, outcome, time and an error code from a fixed list, never text
  or identity.
- The tool name is read early, so calls refused before dispatch are still logged.

## Served text

- Usage guidance travels in four places: the server `instructions` at initialization,
  the tool descriptions in `tools/list`, the descriptions on the input fields, and the
  `next` step on every error result. What the guidance tells the AI is in
  [memos](memos.md) and [setup](setup.md). These are behavioural instructions, not
  server enforcement, and no extra setup tool or prompt capability exists. The detail
  of a save (the tweak and request rules) lives in the field descriptions, which the
  budget test does not measure. Asking the AI for only what the person typed is
  guidance; Milton checks only what [memos](memos.md#the-request) lists.
- There are two instruction variants, read-write and read-only. Both stay under 3,500
  characters, well inside the 4,096 at which Claude Code truncates; a test enforces this
  and that no error handling is left in them. Error handling lives in each error result's
  `next`, and the save fields in `create_memo`'s description.
- A read-only connection is told to ask the person to reconnect with Read and write to
  save memos, and never offers a save.
- Server info carries a description of at most 120 characters for clients that drop
  instructions: read `get_cover_sheet`, then `get_report`, before writing or editing for
  the person.
- `server/test/served-budget.test.ts` reads the tool descriptions an SDK client is
  served, in both connection modes, and keeps each and their total under a budget (the
  2026-11-09 sizes plus 10 to 15%); growing past it means raising the budget there,
  deliberately. It also refuses the retired names in descriptions.
- Each AI's (account and OAuth client) first tool call after a server process starts
  carries `notifications/tools/list_changed` on that call's response stream, ahead of
  its result, as does every `get_report` refused for a missing intent, so clients
  holding tool schemas from before a release refresh them. The server has no open stream
  to push on, so a client hears of a release at its next call. The announced set is per
  process, in memory, and cleared at 10,000.
- The SDK client check (`server/scripts/check-mcp.ts`, run by `mcp.test.ts`) confirms the
  instructions reach a client, exactly three tools and a read, without saving. It does
  not prove a host puts them in model context or that its AI follows them; validate a
  real setup, save and read per supported client.
