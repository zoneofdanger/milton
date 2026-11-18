---
name: ai-grants-spec-2026-11-18
description: The spec Peter approved on 2026-11-18 to keep up to 10 approvals per account and AI client, so one AI on several machines stays connected; frozen
type: research
---

> Historical and frozen. This is the spec as approved by Peter on 2026-11-18, before any
> of it was built. Where it differs from the concept files in `docs/`, those describe
> Milton as it is now ([accounts](../accounts.md), [deletion](../deletion.md),
> [tps-page](../tps-page.md)). As built, native 009 has no down file: the auth migrations
> have no down scripts, and the pre-migration snapshot is the rollback
> ([migrations](../deploy/migrations.md)).

# Spec: several connections per AI client (approved by Peter, 2026-11-18)

## Problem

Claude Code on Peter's work laptop asks to reconnect Milton about daily. Cause, from
production metadata (no content read): when a person approves an AI, the consent trigger
`milton_guard.consent_gate` (auth migration 003, restated in 008) revokes every other
pending or active approval the account holds for the same client id. That assumed one
client id per install, which held for dynamic registration. Claude Code now identifies
with a Client ID Metadata Document: one https URL that every install on every machine
shares. So approving Claude Code on one machine revokes it on every other machine, and
reconnecting there revokes the first. Peter's account: 12 Claude Code approvals since
2026-11-07, 11 revoked within hours to two days; refreshes inside an approval succeed
hourly; each morning a token from a replaced approval gets 400, then a new approval.
Any person using one AI app on two machines or profiles hits this.

## Change

1. **Keep up to 10 active approvals per account and client** (Peter: "allow 10, copy github"). A new approval no longer
   revokes the client's other active ones. If it would make 11, the oldest active
   approvals (earliest `expires_at`, which is approval time plus 30 days) are revoked in
   the same statement, so at most 10 stay active. Milton records no last use, so the oldest goes first (Google's rule; GitHub prefers unused or least recently used). Pending approvals of the same client are
   no longer revoked by another's consent; they still expire on their own short clock.
   - Why 10: GitHub's number. Each active approval is a refresh token that works for 30
     days, so a cap keeps old machines' approvals from piling up. Prior art: GitHub keeps 10 tokens per user, app and scope and revokes the
     oldest past that; Google caps refresh tokens per account and client id (reported as
     50 or 100) the same way.
   - The per-account cap of 256 bindings (all states, pruned a day after expiry) is
     unaffected: fewer reconnects mean fewer bindings.
2. **Disconnect is unchanged:** it revokes every approval of that client for the
   account, on every machine. Reconnecting creates a new one.
3. **Connected AIs shows one row per client** with its access per device, e.g.
   "Read and write on 1 device · Read only on 1 device" (just "Read and write" when there
   is one approval), and one Disconnect that ends them all (as it already does). Today the page lists one row per approval,
   which with this change would show Claude Code twice with two buttons doing the same
   thing.
4. **Unchanged:** refresh-token rotation and reuse detection (a reused token still
   retires its own approval only), token lifetimes (1 h access, 30 d refresh), scopes,
   connection keys, deletion.

## Accepted consequence

Access is now per machine. Approving Claude Code as Read only on one machine no longer
downgrades another machine's Read and write approval; to change access everywhere,
Disconnect and reconnect. The docs say so; the consent screen is unchanged.

## Build

- Native auth migration `009`: `CREATE OR REPLACE FUNCTION milton_guard.consent_gate()`
  with the rule above, otherwise identical to 008's (binding checks, `client_link`
  insert). Down migration restores 008's function. No data change; bindings already
  revoked stay revoked.
- App: group `list_connections` rows in `server/src/auth-assistants.tsx`; the SQL
  function stays as is (bounded at 64 rows).
- Docs: accounts.md (consent and the 10-per-client rule), deletion.md (disconnect ends
  every machine's approval), tps-page.md (grouped rows).
- Tests (auth integration, disposable Postgres): two consents of one client both stay
  active and both refresh; an eleventh revokes exactly the oldest; another client's and
  another account's approvals are untouched; a pending approval survives another's
  consent; disconnect revokes all ten; a token of a revoked approval still gets 401.
- Independent review (Codex, GPT-6 Astra): required, as an auth schema change.

## Release

Auth image and migration 009 per [migrations](../deploy/migrations.md), snapshot first;
app image for the grouped page. Rollback: down migration to 008's function (later
consents revoke others again) and the previous revisions.

## Check after release

Over the next week, Peter's account: no 400 at `/oauth2/token` followed by a new
approval, and no approval revoked except by disconnect or the cap. If 400s remain inside
one approval, look next at refresh-token reuse from concurrent Claude Code sessions
(`refreshTokenReuseInterval` is 0), which this change does not touch.

Until then, a connection key on one machine avoids the problem.
