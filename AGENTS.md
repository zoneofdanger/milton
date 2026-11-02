# Milton: instructions for agents

Milton maintains internal memos containing working instructions and serves their compiled
TPS Report to connected assistants through its MCP server. [SPEC.md](SPEC.md) is the plan and the order of work; the
[README](README.md) says what is here.

## Stop first

- **Memos are served to outside assistants.** Every memo is served to claude.ai,
  ChatGPT, Muse and others. Never put anything about employers, investors, customers, secrets or other people's private details in a memo, a fixture, a commit message or a
  log.
- **Memos change only through Peter.** Assistants submit user-directed instructions through `save_memo`; Milton organizes
  internal memos and compiles TPS in one atomic save. Memo history stays internal;
  TPS has only a current snapshot and revision token. Never edit live memos on your own initiative.
- **Peter's memos live on the server.** Claude Code, Codex and Pi read them from the Milton MCP
  server (`https://mcp.meetmilton.com/mcp`). Change memos through Milton, not by editing files;
  the repository holds only the starter templates.
- **Publishing requires authorization.** Push only when Peter asks. Deploys run from the
  command line: Vercel hosts the static site; Cloud Run hosts the browser app, MCP and
  the private observer. Preserve Cloud Run rollback revisions, pinned images and
  numeric secret versions; the old Vercel app/MCP project is retired.
  Follow [the hosting runbook](server/deploy/README.md).
- **Secrets stay out of git.** Use separate dotenvx payloads and platform-held private keys
  for each runtime. Local environment and key files are ignored; never include them in images.

## Working

- Use Bun for installs, builds and tests; production runs Node 26 LTS. Run `bun run check-types` and `bun test` before you hand work back, and report the exit
  codes.
- For implementation handoffs, include: behavior checked (the exact action, result, and
  environment); not checked (the specific behavior left unverified, and why); and the next
  gate (the check required before a demo, release, or further handoff). Prototypes do not
  need production-grade QA; an intentional omission is fine if stated plainly. Never describe
  an agent report, a commit, or a passing typecheck as proof of behavior that was not observed.
- Keep Milton's look: build pages and any screens from `packages/theme`, and keep the contrast test
  passing.
- One change per commit, by explicit path. Never `git add -A`, `reset --hard`, `stash`, `clean` or
  `rebase`.

## Coordination

Write expected results to the agreed file; Lead reads it before dependent work. Send an
inbox message only when a new decision or blocker changes the plan, or Peter explicitly
requests a handoff. No routine completion notices, acknowledgment loops, reminders, or
resends of accepted messages. Check late notices against current decisions and completed work.

Lead owns delivery and assigns one-off work to temporary agents within the authorized
scope and roster. Persistent collaborators stay focused on their ongoing roles and user
conversations. Use the current recipient recorded in `.agents/tmp/coordination-current.md`.
