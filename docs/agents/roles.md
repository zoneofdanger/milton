---
name: roles
description: Who owns what on the Milton team (builders, milton-duo, milton-overlord, Designer), when review is needed, and which models run
type: rule
---

# Roles

- There is no blocking lead (Peter, 2026-11-07). Peter sets priorities.
- The builder owns implementation, checks and the task PR until it is ready. At the ready
  PR, `milton-duo`, the release coordinator, takes delivery ownership and finishes review,
  integration and authorized deployment with no further acceptance gate.
- `milton-overlord` watches every session, assigns follow-up work, closes coordination
  gaps and tells Peter what he should know or act on; it is not an approval step.
- Designer reviews meaningful UI changes and offers design direction within this same
  process. Preserve specialist work Peter assigns directly.
- Independent review is proportional to consequential behavior, security or data risk:
  always for schema changes, migrations and data deletion; none for docs, backlog and
  copy-only changes, where CI is enough.
- Builders and release workers run Claude Code on Opus 5.5 at high effort; reviewers run
  Codex on GPT-6 Astra.
