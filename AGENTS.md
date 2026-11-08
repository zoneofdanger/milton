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
- **Publishing requires authorization.** Builders may commit/push their assigned task
  branch and open one PR. Only the designated release coordinator, currently
  `milton-duo`, lands/merges and pushes main or deletes landed task branches.
  Roles, assignments and ready PRs grant no extra product publishing authority.
  Force-pushes and history rewrites require Peter's explicit approval. Cloud Run hosts
  the browser app and the MCP server; Vercel builds and publishes the static site from
  main on every push, and a branch build is only ever a preview. Production releases are run by the
  release coordinator (`milton-duo`) from [the hosting runbook](server/deploy/README.md): preserve rollback
  revisions, pinned images and numeric secret versions; snapshot before every migration;
  when a migration drops something the running code reads, release the code first.
  Never drop or migrate the retained `neon_auth` schema.
- **Paid model or provider calls need Peter's approval.**
- **Secrets stay out of git.** One dotenvx payload and one platform-held key per service.
  Local environment and key files are ignored and never enter images, logs, prompts or
  commits.

## Working

- Use Bun for installs, builds and tests; production runs Node 26 LTS. Before handing
  work back run `bun run check-types`, `bun test` and `bun run format:check`, and report
  the exit codes.
- The test suite stays small: add only the tests a change needs, in the existing file
  where they fit; a fix round gets at most one regression test per finding.
- The task PR states: behavior checked (the exact action, result and environment);
  not checked (the specific behavior left unverified, and why); and the next gate (the
  check required before a demo, release or further handoff). Before the PR exists, keep
  this in the brief. Never describe a report, a commit or a passing typecheck as proof
  of behavior nobody observed.
- Served text is contract: the server instructions stay at or under 4,096 characters,
  tool descriptions and the setup script are shown to assistants as written, and a change
  to served text comes with the contract test that parses it.
- Keep Milton's look: build pages and screens from `packages/theme`, and keep the
  contrast test passing.
- Until Milton officially launches, add no backwards-compatibility shims or rollback
  scripts; the snapshot before every migration still applies.
- The operator is Zone of Danger, LLC (comma included) in the footer, privacy policy,
  terms and license.
- [docs/how-milton-works.md](docs/how-milton-works.md) lists Milton's logic, one line
  each. A change to behavior updates its line in the same commit.
- One branch per task in its own worktree under `.worktrees/`; one change per commit, by
  explicit path. Never `git add -A`, `reset --hard`, `stash`, `clean` or `rebase`.
- Landed means deleted: the release coordinator removes the landed worktree and deletes
  its branch in the same step as merging to main. A branch is only ever a preview;
  nothing is published, promoted or released from one. Before any history rewrite, list
  every branch not merged into main and settle each one first.

## Coordination

Lead owns strategy and priorities. The builder owns implementation, checks and the task
PR until it is ready. At the ready PR, `milton-duo` takes delivery ownership and
finishes review, integration and authorized deployment without another Lead acceptance
gate. Designer reviews meaningful UI changes and offers design direction within this
same process. Preserve specialist work Peter assigns directly. Independent review is
proportional to consequential behavior, security or data risk. Builders and release
workers run Claude Code on Opus 5.5 at high effort; reviewers run Codex on GPT-6 Astra.

The PR is the authoritative task record: owner, scope, latest commit, checks and exit
codes, findings, observed and unverified behavior, next action, and publishing
authorization source and scope. Release reads it before dependent work. Before a PR
exists, use one brief; afterward link the PR instead of duplicating status files. Keep
private information out of public PRs.

Git preserves source history and CI records checks. Compare the reviewed commit with
the selected commit; rerun affected checks for real changes, without repeating unchanged
verification merely because ownership changes. Frozen snapshots, hash manifests and
extra acceptance or delivery reports are exceptions for concrete risk, reproducibility
or runbook needs, not default handoffs. Preserve existing artifacts and previews.

Verify Peter's actual publishing decision once, record its source and scope in the task,
and honor existing authorization. A relay alone is not approval. Ask Peter only for
genuinely missing intent or authority; do not repeat Lead sign-off after gates pass.

Inboxes carry only assignments, changed decisions, current blockers and explicitly
requested handoffs. Check current task state before sending or acting; discard
superseded notices without waking completed workers. No routine completion notices,
acknowledgment loops, reminders or resends of accepted messages. Current state and
recipients are in `.agents/tmp/coordination-current.md`.
