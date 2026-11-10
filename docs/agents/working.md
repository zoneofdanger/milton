---
name: working
description: How to build and check a change in Milton: Bun, the checks to run, tests, served text, theme, shims and secrets
type: rule
---

# Working

- Use Bun for installs, builds and tests; production runs Node 26 LTS. Before handing
  work back run `bun run check-types`, `bun test`, `bun run format:check` and
  `bun scripts/agent-docs.ts check`, and report the exit codes.
- The test suite stays small: add only the tests a change needs, in the existing file
  where they fit; a fix round gets at most one regression test per finding.
- Served text is contract: the server instructions stay at or under 4,096 characters,
  tool descriptions and the setup script are shown to AIs as written, and a change to
  served text comes with the contract test that parses it.
- The concept files under `docs/` describe Milton, one home per fact. A change to code
  that a concept file's `covers` lists updates that file in the same PR, or carries a
  `Docs-unchanged: <concept>: <reason>` commit trailer; CI blocks it otherwise.
- Keep Milton's look: build pages and screens from `packages/theme`, and keep the
  contrast test passing.
- Until Milton officially launches, add no backwards-compatibility shims or rollback
  scripts; the snapshot before every migration still applies.
- Secrets stay out of git: one dotenvx payload and one platform-held key per service.
  Local environment and key files are ignored and never enter images, logs, prompts or
  commits.
- The operator is Zone of Danger, LLC (comma included) in the footer, privacy policy,
  terms and license.
