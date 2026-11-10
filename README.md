# Milton

**Make your agents write like you.**

You bring what you want to say. Milton helps your AI write emails and messages in
your voice. Every time you accept a final, your AI keeps a memo: its first draft, your
final, and the tweaks between them ("no warm-up opener in vendor replies"). Next time,
in any AI you connect, Milton hands it your cover sheet, the finals that best match the
draft and the tweaks you keep making.

I built Milton because I was tired of telling Claude to stop using em dashes for the 100th time.

Milton is named after Milton Waddams in Office Space, the collator: he keeps things in order and
hands over the right one.

## How it works

- **Write a short cover sheet.** It's your own voice guide: hard lines every draft
  follows, such as "no em dashes" or "sign off –P". Tell your AI "remember …" or "add to
  my cover sheet" and it adds your exact line, or edit it on your TPS page. It's capped
  at 1,500 characters.
- **Accept a final; your AI keeps a memo.** When you approve a draft, say it's done or
  copy it to use, your AI saves a memo with `create_memo` without asking and tells you
  in one line ("Kept memo: vendor decline, 2 rounds, tweaks: no warm-up opener."). A
  memo is the AI's first draft exactly as shown, your final, one-line tweaks for what
  you made it change, and a one-line summary of the situation. Writing you paste, or ask
  it to remember, is a memo with only a final. Milton stores what the AI sends, with no
  model.
- **Each draft gets its own report.** Before writing, your AI reads `get_cover_sheet`,
  then `get_report` with the situation, medium, audience and purpose. Milton ranks your
  memos and returns the cover sheet, the best-matching finals as examples (your own
  words ahead of equally matching ones, at most three AI drafts you steered, never
  untouched AI drafts), then the tweaks those memos taught. Reads make no model call.
  AIs decide when to read and how to apply them; Milton does not guarantee their
  adherence.
- **See and control what's on file.** Your TPS page shows the cover sheet, your memos
  (newest first, with their rounds, the tweaks served and the tweaks taught), your
  tweaks with counts and a scoreboard of how much your first drafts change. You can
  forget a memo, delete or reword a tweak, turn **Keep memos** off, delete all memos,
  and download everything as `TPS.md`. Memos are kept until you forget them, delete all
  memos or delete your account.

The hosted service is at [meetmilton.com](https://meetmilton.com), in early access.

## Get started

1. Sign in at [app.meetmilton.com](https://app.meetmilton.com/login) with Google or GitHub.
2. Add `https://mcp.meetmilton.com/mcp` in your AI's MCP or connector settings,
   then complete sign-in and approve the connection. Availability depends on the
   AI and your plan.
3. Ask your AI to read your Milton cover sheet. An empty account offers setup once:
   paste about five things you wrote and sent, kept as memos exactly as pasted, then
   start your cover sheet in your words. Milton needs no inbox connection, and none
   of this has to happen before your AI helps.
4. For the next email or DM, give your AI the facts. It reads the report for that
   draft and writes. When you accept the final, it keeps the memo.

Use **Connect an AI** on your TPS page for the connection address and a prompt to
copy. It starts expanded for empty accounts and stays available after your first memo.

Milton supplies usage instructions when your AI connects, plus descriptions for all
three tools and their arguments. These explain when to read, when to keep a memo, how
to write tweaks, how to run first setup, and how to recover an uncertain save. Clients
decide how to present that guidance to their models. If your AI needs a persistent
reminder, add this to its custom instructions or project setup file:

> Before writing anything for me, call Milton's get_cover_sheet, then get_report.

Saving on acceptance is AI guidance, not a server-enforced setting: the AI must call
the tool, and Milton cannot see the conversation. Whether the one-line receipt shows
depends on the client.

## What is here

- [`server/`](server/): the Hono MCP server and web app, with Vite-built assets and Node 26 LTS runtimes. Its three services (app, MCP and self-hosted auth with verified password/email, Google and GitHub) are live on Cloud Run; memos are kept in PostgreSQL. Its README and [hosting runbook](server/deploy/README.md) describe operation, release and rollback.
- [`apps/site`](apps/site/): the Astro page behind `meetmilton.com`.
- [`packages/theme`](packages/theme/): Milton's design tokens, stylesheets, and contrast check.
- [`design/`](design/): Milton's portrait.
- [`docs/how-milton-works.md`](docs/how-milton-works.md): every piece of logic in Milton, one line each.
- [`docs/research/`](docs/research/README.md): dated experiments, evidence and product/source research, including the Honcho comparison.
- [`SPEC.md`](SPEC.md): the design notes and decisions, in the order they were made.

## Working locally

```sh
bun install
bun run check-types
bun test
bun run dev      # the site, through Astro
```

## License

[MIT](LICENSE), © 2026 Zone of Danger, LLC.
