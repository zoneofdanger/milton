---
name: site
description: The static site at meetmilton.com: what Astro builds it from, what Vercel uploads and publishes, and what its pages do
type: reference
covers:
  - apps/site/**
  - .vercelignore
  - scripts/check-site-upload.sh
  - packages/theme/public/**
---

# Site

Local commands and landing content are in [apps/site/README.md](../apps/site/README.md).

## Build and publish

- Astro builds static pages (`output: "static"`, site `https://www.meetmilton.com`) and
  copies the shared fonts and favicons from the theme; the site serves the theme's Latin
  JetBrains Mono subset at the regular font URL.
- Vercel builds and publishes the site from main on every push; a branch build is only
  ever a preview. Vercel hosts nothing else.
- Vercel uploads only what `.vercelignore` keeps: the site, the theme and
  forwarded-client packages, `server/package.json`, and the root `package.json`,
  `bun.lock` and `tsconfig.base.json`. CI builds that same set ([checks](checks.md)).
- Fonts are served with a one-year immutable cache header.

## Pages

- Every static page, including 404, shows the same shared footer navigation, and every
  page loads Vercel Analytics.
- `/for-agents` serves a static product briefing, alternatives, the two tools, when
  memos are saved, export, price, evidence limits and an optional first writing task in
  the initial HTML.
- `/tools` is the public connector reference the AI directories ask for: setup and
  permissions (Read only, Read and write), `get_report` and `create_memo` with their
  inputs, outputs and side effects, the error `next` actions, the retired calls refused,
  and limits. `/support` gives the support address, what to include, and how to delete
  an account. Both are linked from the footer.
- Every page's header holds the brand, "How it works", "Pricing" and a "Sign in" text link
  to the app; on screens 600px wide or less it is one row, the brand and "Sign in".
- The homepage, top to bottom: the headline band with the intro and the "Try Milton free"
  button; the try-it folder, whose caption states the price; the routing slip (how it
  works in three steps), whose cc field links to the AI setup guides; the
  Markdown-file question answered in the open, then four closed questions; and the
  closing "Did you get the memo?" with the button again and a fictional phone message.
  "Try Milton free" is the only button. Its swappable lines sit in one object at the top
  of `apps/site/src/pages/index.astro`. The slip's second row is the onboarding row, "Your
  AI finds a few emails you sent. Only the ones you pick go on file." (Peter, 2026-11-13).
- The try-it folder lets a visitor pick one of three fictional people (Bill, Peter,
  Joanna, first names only) by folder tab and one of three requests, and shows two papers
  side by side, each headed with its word count: "Your AI today" on plain paper and
  "With Milton" on a sheet, each at its own height. Visitors can't paste their own
  writing (Peter, 2026-11-10). Peter and "Ask for something" show first.
- The nine pairs are real drafts from the same system prompt and request through the
  `chat-latest` alias (ChatGPT's current model), which may point at a newer model over
  time: the plain ones on 2026-11-10, the Milton ones on 2026-11-12. Each Milton draft
  was given what Milton serves after setup: its instructions, its two tools and one
  `get_report` result holding the person's five pasted emails as examples, with no change
  lines, since these people have no first drafts yet. They are stored in
  `apps/site/src/data/try-it.json`, whose provenance note lists every edit: the bold
  markers around the subject line are dropped on both sides, two or three spaced em
  dashes were added by hand to each "Your AI today" email for effect (Peter,
  2026-11-10), Bill's fictional employer is renamed in the plain emails, and one plain
  email's subject is shortened. The "With Milton" emails are otherwise as generated, each
  on its first try; `try-it-milton-originals.json` beside it keeps them exactly as
  returned, with their requests, and the site does not import it. The folder's foot says
  the dashes were added.
- The folder's foot holds a closed disclosure ("See what Milton has on file for Peter")
  with the emails on file for that person.
- Everything is rendered at build time with no motion. Without JavaScript every person
  and pair shows as plain sections with every email open; with it, the tabs and request
  pickers (real buttons with `aria-pressed`) swap the pair in place without
  announcements. On screens up to 767px wide the price caption sits above the tabs, the
  requests are one native select, and the plain email shows its first lines with a
  "Read all N words" button, so both papers start in the first screen. Picks, and clicks
  on the hero's "Try Milton free" button (not the closing one), are sent as Vercel
  Analytics custom events with the current pick.
- The setup widget on `/setup` copies the shared setup prompt ([setup](setup.md)), falls back to
  manual selection, and closes on Escape or an outside click.
- `/pricing` states the one plan ($5.01 USD a month after a 30-day free trial, no card
  needed to start, charged only if a card is added), what it includes, a link to sign in
  at the app, and a short FAQ: what happens after the trial, how to cancel (Stripe's
  portal from the app's account menu, effective at the end of the billing period, with a
  link to the payment and refund terms), and that the AI decides how it follows the
  memo.
- `/demo` is an unlinked preview of the demo clip ([demo](demo.md)): in no navigation or
  footer, marked `noindex` (the layout's `noindex` prop), and there is no sitemap. It plays
  `src/data/milton-demo.cast` in asciinema-player 3.17.0 (Apache-2.0, pinned exactly),
  using the upstream prebuilt bundle and stylesheet, which the build serves from
  `/_astro/`; nothing loads from a CDN. The player runs at speed 1.5 with a 1 s idle
  limit and fits the page width, so at phone width the terminal text is about 6px. Under
  it are the clip's label, the one-line Claude Code setup command from `/setup`, and a
  link to `/setup`.
- `/research` presents the approved testing notes, linked from About and the site
  footer. `/notes` is retired with no redirect or alias, so old URLs reach the normal 404.
