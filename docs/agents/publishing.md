---
name: publishing
description: Who may push, merge, publish and release Milton, and the rules every production release keeps
type: rule
---

# Publishing

- Builders may commit and push their assigned task branch and open one PR. Roles,
  assignments and ready PRs grant no extra product publishing authority.
- A branch is only ever a preview: nothing is published, promoted or released from one.
  Vercel builds and publishes the static site from main on every push.
- Cloud Run hosts the auth service, the browser app, the MCP server and the admission
  service. Production releases are run by the release coordinator from
  [the hosting runbook](../../server/deploy/README.md): preserve rollback revisions,
  pinned images and numeric secret versions; snapshot before every migration; when a
  migration drops something the running code reads, release the code first.
- Landed means deleted: the release coordinator removes the landed worktree and deletes
  its branch in the same step as merging to main.
- Before any history rewrite, list every branch not merged into main and settle each one
  first.
