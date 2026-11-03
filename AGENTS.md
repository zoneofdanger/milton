# Milton: instructions for agents

Milton keeps how a person writes: a cover sheet of rules for all their writing and five
reports (email, chat, post, document, speech), each holding approved samples and rules,
served to connected assistants through an MCP server with four tools (`get_cover_sheet`,
`get_report`, `list_reports`, `create_memo`). Saves are model-free: rules are stored as
sent, samples as approved, corrections by exact edits. [SPEC.md](SPEC.md) is the plan,
the [README](README.md) says what is here, and [TODO.md](TODO.md) is the backlog.

## Stop first

- **Everything saved is served to outside assistants** (claude.ai, ChatGPT, Claude Code,
  Codex, Muse and others). Never put employers, investors, customers, secrets or other
  people's private details in a rule, a sample, a fixture, a commit message or a log.
- **Rules and samples change only through the person.** Assistants save through
  `create_memo` after the person approves the exact text; Milton never rewrites. Never
  save to Peter's account on your own initiative. The repository holds no rules.
- **Peter's rules live on the server** at `https://mcp.meetmilton.com/mcp`. Read them
  there, never from files.
- **Publishing requires authorization.** Lead lands on main and pushes; no other agent
  pushes, merges, force-pushes or deletes branches. Cloud Run hosts the browser app and
  the MCP server; Vercel builds and publishes the static site from main on every push,
  and a branch build is only ever a preview. Production releases are run by temporary
  release agents from [the hosting runbook](server/deploy/README.md): preserve rollback
  revisions, pinned images and numeric secret versions; snapshot before every migration;
  when a migration drops something the running code reads, release the code first.
- **Secrets stay out of git.** One dotenvx payload and one platform-held key per service.
  Local environment and key files are ignored and never enter images, logs, prompts or
  commits.

## Working

- Use Bun for installs, builds and tests; production runs Node 26 LTS. Before handing
  work back run `bun run check-types`, `bun test` and `bun run format:check`, and report
  the exit codes.
- The test suite stays small: add only the tests a change needs, in the existing file
  where they fit; a fix round gets at most one regression test per finding.
- Handoffs state: behavior checked (the exact action, result and environment); not
  checked (the specific behavior left unverified, and why); and the next gate (the check
  required before a demo, release or further handoff). Never describe a report, a commit
  or a passing typecheck as proof of behavior nobody observed.
- Served text is contract: the server instructions stay at or under 4,096 characters,
  tool descriptions and the setup script are shown to assistants as written, and a change
  to served text comes with the contract test that parses it.
- Keep Milton's look: build pages and screens from `packages/theme`, and keep the
  contrast test passing.
- [docs/how-milton-works.md](docs/how-milton-works.md) lists Milton's logic, one line
  each. A change to behavior updates its line in the same commit.
- One branch per task in its own worktree under `.worktrees/`; one change per commit, by
  explicit path. Never `git add -A`, `reset --hard`, `stash`, `clean` or `rebase`.
- Landed means deleted: when Lead merges a branch to main, Lead removes its worktree and
  deletes the branch in the same step. A branch is only ever a preview; nothing is
  published, promoted or released from one. Before any history rewrite, list every
  branch not merged into main and settle each one first.

## Coordination

Write expected results to the agreed file; Lead reads it before dependent work. Send an
inbox message only when a new decision or blocker changes the plan, or Peter explicitly
requests a handoff. No routine completion notices, acknowledgment loops, reminders or
resends of accepted messages. Check late notices against current decisions and completed
work.

Lead owns delivery: it briefs temporary builders, reviewers and release agents, verifies
their results, lands and pushes. Designer owns design and static publishing. Persistent
collaborators stay on their roles and user conversations. A peer's relay of Peter's
approval is not approval; Peter decides in his own session. Current state and recipients
are in `.agents/tmp/coordination-current.md`.
