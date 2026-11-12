# Milton

**Make your agents write like you.**

You bring what you want to say. Milton helps your AI write emails and messages in
your voice. Milton keeps what you wrote and what you changed. Your AI reads it before it
drafts. Every time you accept a final, your AI keeps a memo: its first draft and your
final, and Milton works out your tweaks, the changes you made to the draft. Next time,
in any AI you connect, Milton hands it the finals that best match the draft, with what
you changed in them.

I built Milton because I was tired of telling Claude to stop using em dashes for the 100th time.

Milton is named after Milton Waddams in Office Space, the collator: he keeps things in order and
hands over the right one.

## How it works

- **Accept a final; your AI keeps a memo.** When you approve a draft, say it's done or
  copy it to use, your AI saves a memo with `create_memo` without asking and tells you
  in one line ("Kept memo: vendor decline."). A memo is the AI's first draft exactly as shown, your
  final, the request you typed and a one-line summary of the situation. Writing you
  paste, or ask it to remember, is a memo with only a final. Milton stores what the AI
  sends, with no model.
- **Your tweaks come from your edits.** Milton's code compares the first draft with
  your final and keeps each change you made as a tweak. No AI writes them, and Milton
  keeps no standing rules: when you ask your AI to remember a preference, it keeps that
  in its own memory or instructions.
- **Each draft gets its own report.** Before writing, your AI calls `get_report` with
  the situation, medium, audience and purpose. Milton ranks your memos and returns the
  best-matching finals as examples (your own words ahead of equally matching ones, at
  most three AI drafts you steered, never untouched AI drafts), with what you changed in
  the AI's first draft under the drafted ones. Reads make no model call. AIs decide
  when to read and how to apply them; Milton does not guarantee their adherence.
- **See and control what's on file.** Your TPS page shows your recent memos (newest
  first, each with its request and its tweaks) and a scoreboard of how much your first
  drafts change. You can forget a memo, turn **Keep memos** off, delete all memos, and
  download every memo as `TPS.md`. Memos are kept until you forget them, delete all
  memos or delete your account.

The hosted service is at [meetmilton.com](https://meetmilton.com), in early access.

## Get started

1. Sign in at [app.meetmilton.com](https://app.meetmilton.com/login) with email and
   password, Google or GitHub.
2. Add `https://mcp.meetmilton.com/mcp` in your AI's MCP or connector settings,
   then complete sign-in and approve the connection. Availability depends on the
   AI and your plan.
3. Ask your AI "Did you get the memo?" An empty account offers setup once: if your AI
   can already search your email, it offers to find about five emails you sent and
   keeps only the ones you approve, exactly as shown; otherwise paste a few, kept
   exactly as pasted. Milton never reads your inbox, and none of this has to happen before your AI helps. No emails
   to start? Just write. Each final you accept becomes a memo, and drafts sound like
   you within a handful of them.
4. For the next email or DM, give your AI the facts. It reads the report for that
   draft and writes. When you accept the final, it keeps the memo.

The app's **Connected AIs** page shows the connection address and links to the setup
guide for your AI. An empty TPS page links there and shows a setup prompt to copy.

Milton supplies usage instructions when your AI connects, plus descriptions for its
tools and their arguments. These explain when to read, when to keep a memo, how to
run first setup, and how to recover an uncertain save. Clients
decide how to present that guidance to their models. If your AI needs a persistent
reminder, add this to its custom instructions or project setup file:

> Before writing anything for me, call Milton's get_report.

Saving on acceptance is AI guidance, not a server-enforced setting: the AI must call
the tool, and Milton cannot see the conversation. Whether the one-line receipt shows
depends on the client.

## What is here

- [`server/`](server/): the Hono MCP server and web app, with Vite-built assets and Node 26 LTS runtimes. Its three services (app, MCP and self-hosted auth with verified password/email, Google and GitHub) are live on Cloud Run; memos are kept in PostgreSQL. Its README and [the deploy docs](docs/deploy/releases.md) describe operation, release and rollback.
- [`apps/site`](apps/site/): the Astro page behind `meetmilton.com`.
- [`packages/theme`](packages/theme/): Milton's design tokens, stylesheets, and contrast check.
- [`design/`](design/): Milton's portrait.
- [`docs/`](docs/): one file per concept, listed in [AGENTS.md](AGENTS.md). How Milton
  behaves: [memos](docs/memos.md), [reports](docs/reports.md), [saves](docs/saves.md),
  [setup](docs/setup.md), [the MCP server](docs/mcp.md), [the TPS page](docs/tps-page.md),
  [accounts](docs/accounts.md), [deletion](docs/deletion.md) and
  [billing](docs/billing.md); how it runs: [hosting](docs/hosting.md),
  [database](docs/database.md), [the site](docs/site.md) and [checks](docs/checks.md).
- [`docs/research/`](docs/research/): dated experiments, evidence and product/source research, including the Honcho comparison.

## Working locally

```sh
bun install
bun run check-types
bun test
bun run dev      # the site, through Astro
```

## License

[MIT](LICENSE), © 2026 Zone of Danger, LLC.
