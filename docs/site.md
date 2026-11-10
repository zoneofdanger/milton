---
name: site
description: The static site at meetmilton.com: what Astro builds it from, what Vercel uploads and publishes, and what its pages do
type: reference
covers:
  - apps/site/astro.config.mjs
  - apps/site/vercel.json
  - apps/site/src/components/**
  - apps/site/src/layouts/**
  - .vercelignore
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
- The hero demo shows one fictional cleanup request with illustrative plain-AI and
  Milton outputs; build-time ordered word matching computes words kept from the
  displayed strings, ignoring case and punctuation except normalized internal
  apostrophes, and unmatched output words stay underlined. One 10,500 ms clock sweeps a
  paper tint over edits with two 2,150 ms reading holds; all text and scores remain
  readable throughout, with no playback controls or status announcements.
- Playback waits for 35% card visibility, or 80% of the maximum visible card area when a
  short viewport cannot show 35%; resizing updates that threshold, and playback pauses
  off-screen or in a hidden tab, preserving its position.
- Reduced motion or disabled JavaScript shows the complete illustration without
  animation.
- The setup widget copies the shared setup prompt ([setup](setup.md)), falls back to
  manual selection, and closes on Escape or an outside click.
- The fake crowdfunding campaign on `/pricing` is static data.
- `/research` presents the approved testing notes, linked from About and the site
  footer. `/notes` is retired with no redirect or alias, so old URLs reach the normal 404.
