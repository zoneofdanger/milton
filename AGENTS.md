# Milton: instructions for agents

Milton keeps how a person writes and serves it to their connected AIs through an MCP
server with three tools. The [README](README.md) introduces it and [TODO.md](TODO.md) is
the backlog. The concept files indexed below hold everything else: read the index, then
open only the files your task needs. Until it is dissolved into concept files,
[SPEC.md](SPEC.md) also describes product behaviour.

## Stop first

- Everything saved is served to outside AIs. Never put employers, investors, customers,
  secrets or other people's private details in a memo, tweak, cover sheet line, fixture,
  commit message or log.
- Memos and the cover sheet belong to the person; Milton never rewrites what it is sent.
  Never save to Peter's account on your own initiative. His writing lives on the server
  (`https://mcp.meetmilton.com/mcp`), never in files or this repository.
- Only the release coordinator, `milton-duo`, merges, pushes main, releases or deletes
  branches. Force-pushes and history rewrites need Peter's explicit approval.
- Paid model or provider calls need Peter's approval.
- Never `git add -A`, `reset --hard`, `stash`, `clean` or `rebase`. Never drop or migrate
  the retained `neon_auth` schema.

## Concepts

<!-- concepts:start -->

- [agents/approval](docs/agents/approval.md) — What counts as Peter's approval, including his words relayed from another session, and when to ask him
- [agents/branches](docs/agents/branches.md) — One branch and worktree per task, one change per commit, staged by explicit path
- [agents/messaging](docs/agents/messaging.md) — What goes in another Milton session's inbox, and how sessions are found
- [agents/publishing](docs/agents/publishing.md) — Who may push, merge, publish and release Milton, and the rules every production release keeps
- [agents/pull-requests](docs/agents/pull-requests.md) — What a Milton task PR records, and how checks and evidence carry across a handoff
- [agents/roles](docs/agents/roles.md) — Who owns what on the Milton team (builders, milton-duo, milton-overlord, Designer), when review is needed, and which models run
- [agents/working](docs/agents/working.md) — How to build and check a change in Milton: Bun, the checks to run, tests, served text, theme, shims and secrets
- [how-milton-works](docs/how-milton-works.md) — Every piece of Milton's logic, one line each, until it is split into concept files
- [research/derived-systems-2026](docs/research/derived-systems-2026.md) — November 2026: the embeddings, advisory graph, task retrieval and gardening Milton built, measured and removed, and what would justify rebuilding
- [research/honcho-2026](docs/research/honcho-2026.md) — Honcho compared with Milton on 2026-11-05: a substantial overlap in person memory; Milton's distinction was a writing workflow on approved examples
- [research/honcho-source-2026](docs/research/honcho-source-2026.md) — Honcho source read at a pinned commit, 2026-11-05: context delivery varied by client; no reason found to add embeddings or autonomous learning
- [research/pg-style-guide-ablation-2026-11-05](docs/research/pg-style-guide-ablation-2026-11-05.md) — 2026-11-05 pilot on ten briefs: adding a written style guide to three Paul Graham essays gave no clear overall gain, judged by one model
- [research/pg-style-guide-ablation-drafts-2026-11-05](docs/research/pg-style-guide-ablation-drafts-2026-11-05.md) — The exact briefs and unedited first drafts, both conditions, behind the 2026-11-05 Paul Graham style-guide pilot
- [research/sample-ranking-2026](docs/research/sample-ranking-2026.md) — November 2026 offline tests on fictional authors: labels plus full text shipped, embeddings were rejected, better picks did not write better drafts
- [research/spiral-teardown-2026-11-05](docs/research/spiral-teardown-2026-11-05.md) — Spiral teardown, 2026-11-05: its public claims, Styles dashboard and two generated style guides, and a plausible reconstruction of how it works
- [research/spiral-tool-library-pilot-2026-11-05](docs/research/spiral-tool-library-pilot-2026-11-05.md) — 2026-11-05 pilot: one Milton-assisted draft and three Spiral drafts of one essay brief, preserved exactly; small, unblinded and with no winner
- [research/writing-evidence-2026](docs/research/writing-evidence-2026.md) — November 2026 reading of three papers and GBrain's record: examples beat nothing, formality is the default to override, and much is untested

<!-- concepts:end -->
