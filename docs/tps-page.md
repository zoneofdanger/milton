---
name: tps-page
description: The web app a signed-in person sees: the TPS page, one memo, memo settings, the TPS.md export and the Connected AIs page
type: behaviour
covers:
  - server/src/pages.tsx
  - server/src/memo-pages.tsx
  - server/src/store/tps.ts
  - server/src/auth-assistants.tsx
  - server/src/*.css
  - server/src/auth-account.tsx
  - server/src/auth.tsx
  - server/src/store/index.ts
  - packages/theme/*.css
  - server/src/auth-session.tsx
  - server/src/auth-lifecycle.ts
---

# TPS page

What each change does to memos, tweaks and the cover sheet is in [memos](memos.md) and
[deletion](deletion.md); sign-in is in [accounts](accounts.md); billing items are in
[billing](billing.md).

## Pages

- Pages run no scripts, under a strict CSP, and are not cached; they escape their text,
  link content-versioned assets and preload Geist and the Latin JetBrains Mono subset.
  The full JetBrains Mono master loads only for other characters, and the theme uses
  `font-display: optional` to avoid a late font swap.
- A page route that fails shows "Unable to continue" at the error's status, with a link
  back where one applies. An unknown error there reads as a 503 and is logged.
- Each view makes one structured read; a failed read fails the page, with no plain-text
  fallback. The web view reads no store limits and makes no account check of its own:
  its account lookup and each read require an active account.
- The home page shows a marketing page signed out and the TPS page signed in;
  `/tps-report` shows the same TPS page.
- Account opens a native popover; Escape closes it and returns focus to Account, and
  clicking outside closes it.

## The TPS page

- It reads in one statement: the cover sheet and its version, the Keep memos switch, the
  newest 200 memos (older ones stay in the export), every tweak with its count (most
  cited first) and the scoreboard ([memos](memos.md)).
- Each listed memo shows its time, AI, medium, kind, summary, audience, purpose, mode,
  rounds, change, tier, the tweaks its report served (those still on file) and the
  tweaks it taught; its first draft and final load only when that memo is opened.
- `/tps/memo/<id>` shows one memo in full (first draft or why there is none, final,
  context, served and taught tweaks, Forget); another account's or an unknown id is a 404.
- The cover sheet is shown read only, one ruled line per line as written, blank lines
  kept, with a note that an AI connected with Read and write changes it; an empty one
  says "No cover sheet yet." and how to start one. There is no cover sheet form
  (Peter, 2026-11-10; [memos](memos.md)).
- The person can forget one memo, and delete or reword a tweak.
- An empty TPS page links to the Connected AIs page and shows the shared setup prompt
  ([setup](setup.md)) to copy; an account with memos gets a shorter prompt for the next
  draft instead.
- Every TPS page change is a POST with the CSRF and Origin checks, then redirects back
  with a notice.
- Every TPS page change runs in its own transaction under the account lock
  ([saves](saves.md)): forgetting one memo, Delete all memos, deleting or rewording a
  tweak, and the Keep memos switch.

## Memo settings

- `/account/memos` holds the **Keep memos** switch, on by default ([memos](memos.md)).
- "Delete all memos" asks on its own page (`/account/memos/delete`) and runs only with
  the confirming field ([deletion](deletion.md)).

## TPS.md

- `/download` returns the complete writing export as `TPS.md`, including when AI access
  is paused: the cover sheet, the tweaks with counts (most cited first), then every
  memo's final grouped by medium, newest first, each under its kind and date with its
  summary. First drafts are not in it.

## Connected AIs

- `/assistants` shows the connection address and links to the setup guides.
- It lists bounded live native connections grouped by client and read/write access,
  and original incomplete disconnects; a full native page says the listing is
  incomplete. Disconnecting is in [deletion](deletion.md).
- It also lists connection keys and the key form ([accounts](accounts.md)).
