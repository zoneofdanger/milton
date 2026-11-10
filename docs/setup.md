---
name: setup
description: First setup on an empty account (offered once, about five pastes, the cover sheet, the standing line), the shared setup prompt and shared facts
type: behaviour
covers:
  - server/src/store/setup.ts
  - packages/theme/setup-prompt.ts
  - packages/theme/facts.ts
  - server/src/mcp-tools.ts
  - server/src/mcp.ts
  - server/src/memo-pages.tsx
  - server/src/billing.tsx
  - apps/site/src/components/AssistantSetup.astro
  - apps/site/src/pages/setup.astro
  - server/test/copy-drift.test.ts
  - server/src/store/memos.ts
---

# Setup

## The served script

- Setup is served in `get_cover_sheet`'s `setup` while `is_empty` says the account has no
  cover sheet and no memos ([mcp](mcp.md)); a read-only connection gets a permission line
  instead.
- The AI offers it once. A request to set up Milton accepts it, and a declined offer is
  not repeated.
- Setup never blocks a writing task, never reads an inbox, connects mail or imports
  anything the person didn't paste. A writing or clean-up task the person brings comes
  first; setup resumes after it.
- The connection is confirmed only after a successful `get_cover_sheet` read.
- The AI first asks the person to paste about five things they wrote and sent
  (emails, messages, posts), unedited, saying Milton keeps each as a memo. It saves each
  as a final-only memo exactly as pasted, with a one-line context and a kind, and tells
  them each receipt. Only their own writing: it skips automated, forwarded and other
  people's text and anything holding secrets. Those finals are your words, the top tier
  ([memos](memos.md)).
- Then it offers to start the cover sheet with a few short lines the person gives, added
  in their words, never suggested from their writing.
- Every setup includes the standing line (below): the AI shows it and asks on its own,
  adding it where the AI supports standing instructions only after the person agrees,
  or shows where to paste it.
- The script carries one fictional final-only memo as a JSON example.
- Milton cannot inspect another AI's memory and does not guarantee AIs follow its
  instructions.

## The setup prompt

- One shared prompt (`SETUP_PROMPT`) serves the site's setup widget and the app's empty
  TPS page ([TPS page](tps-page.md)). It asks the AI to connect, read what is on file,
  ask first for about five pieces the person wrote and sent and keep each as a memo
  exactly as pasted, take optional cover sheet lines, show the standing line and add it
  once the person says yes, help with a writing or clean-up task first if the person
  would rather, and never wait on any of it.

## Shared facts

- `packages/theme/facts.ts` holds the facts the site, the app and the served text all
  state: the standing line ("Before writing anything for me, call Milton's
  get_cover_sheet, then get_report."), the 30-day trial and the $5.01 price. The setup
  script, the setup page and Stripe's trial read them; the copy-drift test checks prose
  that repeats them ([checks](checks.md)).
