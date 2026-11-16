# Milton: instructions for agents

Milton keeps how a person writes and serves it to their connected AIs through an MCP
server with two tools. The [README](README.md) introduces it and [TODO.md](TODO.md) is
the backlog. The concept files indexed below hold everything else.

## Read before you act

- Before any change: [working](docs/agents/working.md), [branches](docs/agents/branches.md)
  and [pull requests](docs/agents/pull-requests.md).
- Before acting on approval or on Peter's words relayed by another session:
  [approval](docs/agents/approval.md).
- Before pushing, merging, releasing or deleting a branch:
  [publishing](docs/agents/publishing.md). Before messaging another session:
  [messaging](docs/agents/messaging.md). Who reviews and delivers: [roles](docs/agents/roles.md).
- Before writing copy or proposing a feature: [positioning](docs/positioning.md). For product
  work, read the concept files the task touches.

## Stop first

- Everything saved is served to outside AIs. Never put employers, investors, customers,
  secrets or other people's private details in a memo, tweak, fixture, commit message or
  log.
- Memos belong to the person. Their AI saves a memo when they accept a final, and Milton's
  code, not an AI, works out its tweaks; Milton never rewrites what it is sent. Never save to Peter's account on your own initiative. His writing lives on the
  server (`https://mcp.meetmilton.com/mcp`), never in files or this repository.
- Only the release coordinator, `milton-duo`, merges, pushes main, releases or deletes
  landed task branches. Force-pushes and history rewrites need Peter's explicit approval.
- Paid model or provider calls need Peter's approval.
- Never `git add -A`, `reset --hard`, `stash`, `clean` or `rebase`. Never drop or migrate
  the retained `neon_auth` schema.

## Concepts

<!-- concepts:start -->

- [accounts](docs/accounts.md) — Sign-in through the self-hosted auth service, app sessions and OIDC, admission and account creation, open sign-ups, and connection keys
- [agents/approval](docs/agents/approval.md) — What counts as Peter's approval, including his words relayed from another session, and when to ask him
- [agents/branches](docs/agents/branches.md) — One branch and worktree per task, one change per commit, staged by explicit path
- [agents/messaging](docs/agents/messaging.md) — What goes in another Milton session's inbox, and how sessions are found
- [agents/publishing](docs/agents/publishing.md) — Who may push, merge, publish and release Milton, and the rules every production release keeps
- [agents/pull-requests](docs/agents/pull-requests.md) — What a Milton task PR records, and how checks and evidence carry across a handoff
- [agents/roles](docs/agents/roles.md) — Who owns what on the Milton team (builders, milton-duo, milton-overlord, Designer), when review is needed, and which models run
- [agents/working](docs/agents/working.md) — How to build and check a change in Milton: Bun, the checks to run, tests, served text, theme, shims and secrets
- [billing](docs/billing.md) — Trials, the one plan and Stripe (checkout, portal, webhook), access by subscription status, trial notices, store limits and usage rows
- [checks](docs/checks.md) — What CI runs on every push and PR, the migration guards, the copy-drift and contrast tests, agent-docs check, and the theme package
- [database](docs/database.md) — The one shared Postgres: tenancy, runtime roles and their grants and timeouts, what the schema enforces, migrations and backups
- [deletion](docs/deletion.md) — What the person controls and how long Milton keeps it: forgetting, Delete all memos, disconnecting an AI, account deletion and the deletion inventory
- [demo](docs/demo.md) — Recording and assembling the demo clip: Sam's repo, the driver typing into real Claude Code and its guards, scenes, privacy scan and title cards
- [deploy/alerts](docs/deploy/alerts.md) — Milton's production alerts as code: each policy, its threshold and reason, the release gate, and how monitoring.ts plans and applies them
- [deploy/cloud](docs/deploy/cloud.md) — Milton's hosting as operated: the services, cloud resources and edge, the admission service, secrets and the database logins
- [deploy/e2e](docs/deploy/e2e.md) — The fictional test account and the twice-daily end-to-end check against production: provisioning, the run, the job, key renewal
- [deploy/migrations](docs/deploy/migrations.md) — How a production schema change is snapshotted, run and checked, the Neon lessons behind each step, and how the database is restored
- [deploy/releases](docs/deploy/releases.md) — How a Milton release is built, deployed, verified, gated and rolled back on Cloud Run, and how Turnstile is switched on
- [deploy/serving](docs/deploy/serving.md) — What runs in production now: each service's revision, image and secrets, the rollback targets and floor, schema heads and snapshots to keep
- [deploy/stripe](docs/deploy/stripe.md) — Operating Stripe for Milton: live mode, the Dashboard settings billing relies on, and the subscription backfill and resync
- [history](docs/history.md) — Append-only record of Milton's production releases and applied one-time migrations, newest first, with revisions and snapshot names
- [hosting](docs/hosting.md) — Where Milton runs (Cloud Run services, the Vercel site), startup and configuration, every HTTP request, static assets and the operation scripts
- [mcp](docs/mcp.md) — An MCP call from token or key to tool result, the two tools and their arguments, retired calls, outcomes and next steps, and the served-text contract
- [memos](docs/memos.md) — What a memo, tweak and report are; what a memo holds, its tier, change score and tweaks; kinds, legacy data and when AIs save
- [positioning](docs/positioning.md) — What Milton is for and how to judge features, copy and backlog against it: your AI writes like you
- [reports](docs/reports.md) — How get_report reads, writing nothing, and how a report ranks memos, picks examples and their changes, counts memos and prints its text
- [research/derived-systems-2026](docs/research/derived-systems-2026.md) — November 2026: the embeddings, advisory graph, task retrieval and gardening Milton built, measured and removed, and what would justify rebuilding
- [research/honcho-2026](docs/research/honcho-2026.md) — Honcho compared with Milton on 2026-11-05: a substantial overlap in person memory; Milton's distinction was a writing workflow on approved examples
- [research/honcho-source-2026](docs/research/honcho-source-2026.md) — Honcho source read at a pinned commit, 2026-11-05: context delivery varied by client; no reason found to add embeddings or autonomous learning
- [research/memo-evidence-spec-2026-11-11](docs/research/memo-evidence-spec-2026-11-11.md) — The memo-evidence spec Peter approved on 2026-11-11: checked tweak quotes, code-found changes, a tweak score and the typed request; frozen
- [research/memos-spec-2026-11-09](docs/research/memos-spec-2026-11-09.md) — The memos-and-tweaks spec Peter approved on 2026-11-09 for the memos release (#76), with its reasons and rejected options; frozen
- [research/own-words-sentence-2026-11](docs/research/own-words-sentence-2026-11.md) — 2026-11-10 and 11 tests of one served sentence, fictional people: drafts kept more of the person's own phrases and lost no fact or reply need
- [research/pg-style-guide-ablation-2026-11-05](docs/research/pg-style-guide-ablation-2026-11-05.md) — 2026-11-05 pilot on ten briefs: adding a written style guide to three Paul Graham essays gave no clear overall gain, judged by one model
- [research/pg-style-guide-ablation-drafts-2026-11-05](docs/research/pg-style-guide-ablation-drafts-2026-11-05.md) — The exact briefs and unedited first drafts, both conditions, behind the 2026-11-05 Paul Graham style-guide pilot
- [research/rules-spec-2026-11-12](docs/research/rules-spec-2026-11-12.md) — The spec Peter approved on 2026-11-12 to fold the cover sheet into "tweaks you said"; his later decisions replaced it with memos and tweaks only
- [research/sample-ranking-2026](docs/research/sample-ranking-2026.md) — November 2026 offline tests on fictional authors: labels plus full text shipped, embeddings were rejected, better picks did not write better drafts
- [research/serve-changes-test-2026-11-11](docs/research/serve-changes-test-2026-11-11.md) — 2026-11-11 offline test, fictional people: code-cut changes under each example cut targeted voice flags from 16 to 9 on 21 drafts, one model
- [research/spiral-teardown-2026-11-05](docs/research/spiral-teardown-2026-11-05.md) — Spiral teardown, 2026-11-05: its public claims, Styles dashboard and two generated style guides, and a plausible reconstruction of how it works
- [research/spiral-tool-library-pilot-2026-11-05](docs/research/spiral-tool-library-pilot-2026-11-05.md) — 2026-11-05 pilot: one Milton-assisted draft and three Spiral drafts of one essay brief, preserved exactly; small, unblinded and with no winner
- [research/stated-lines-test-2026-11-12](docs/research/stated-lines-test-2026-11-12.md) — 2026-11-12 offline test, fictional people: hard lines served as "tweaks they said" broke as rarely as on a cover sheet, on two models; neither shipped
- [research/writing-evidence-2026](docs/research/writing-evidence-2026.md) — November 2026 reading of three papers and GBrain's record: examples beat nothing, formality is the default to override, and much is untested
- [saves](docs/saves.md) — How a create_memo save commits: the account lock, receipts, replay and request hashing, refusals, savepoints and the request size
- [setup](docs/setup.md) — First setup on an account with no memos (offered once, optional sent emails or about five pastes, the standing line), setup prompt and shared facts
- [site](docs/site.md) — The static site at meetmilton.com: what Astro builds it from, what Vercel uploads and publishes, and what its pages do
- [tps-page](docs/tps-page.md) — The web app a signed-in person sees: the TPS page, one memo, memo settings, the TPS.md export and the Connected AIs page

<!-- concepts:end -->
