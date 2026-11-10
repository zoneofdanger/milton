---
name: messaging
description: What goes in another Milton session's inbox, and how sessions are found
type: rule
---

# Messaging

- Inboxes carry only assignments, changed decisions, current blockers and explicitly
  requested handoffs.
- Check current task state before sending or acting; discard superseded notices without
  waking completed workers.
- No routine completion notices, acknowledgment loops, reminders or resends of accepted
  messages.
- Sessions are addressed by name (`milton-duo`, `milton-overlord`, and so on): list them
  with `ListAgents` in Claude Code or `herdr agent list`. No file records current state;
  the PR does.
