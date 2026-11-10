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
- `/for-agents` serves a static product briefing, alternatives, the three tools, when
  memos are saved, export, price, evidence limits and an optional first writing task in
  the initial HTML.
- The hero's try-it box ("Did you get the memo?") lets a visitor pick one of three
  fictional people (Bill, Peter, Joanna, first names only) and one of three requests, and
  shows two memo sheets: "Your AI today" and "With Milton". Visitors can't paste their
  own writing (Peter, 2026-11-10). Peter and "Ask for something" show first.
- The nine pairs are real drafts, generated once each by `claude-sonnet-5-5` on
  2026-11-10 from the same system prompt and request, the Milton one also given that
  person's cover sheet and report as Milton serves them. They are stored unedited in
  `apps/site/src/data/try-it.json`; only the bold markers around "Subject:" are dropped
  for display. A draft that can't be shown is regenerated, never edited.
- Under the "With Milton" email, a closed disclosure ("See Peter's 5 setup emails and
  cover sheet") holds that person's setup emails and cover sheet. One line under the
  memos lists what changed (greeting, opening words and sign-off when they differ, and
  length), from values computed by code when the drafts were generated.
- Everything is rendered at build time with no motion. Without JavaScript every person
  and pair shows as plain sections; with it, the pickers (real buttons with
  `aria-pressed`) swap the pair in place without announcements. Picks, and clicks on
  the hero's "Try Milton free" button (not the closing one), are sent as Vercel Analytics
  custom events with the current pick.
- The setup widget copies the shared setup prompt ([setup](setup.md)), falls back to
  manual selection, and closes on Escape or an outside click.
- `/pricing` states the one plan ($5.01 USD a month after a 30-day free trial, no card
  needed to start, charged only if a card is added), what it includes, a link to sign in
  at the app, and a short FAQ: what happens after the trial, how to cancel (Stripe's
  portal from the app's account menu, effective at the end of the billing period, with a
  link to the payment and refund terms), and that the AI decides how it follows the
  memo.
- `/research` presents the approved testing notes, linked from About and the site
  footer. `/notes` is retired with no redirect or alias, so old URLs reach the normal 404.
