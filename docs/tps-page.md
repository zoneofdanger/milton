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
  cited first) and score, and the scoreboard ([memos](memos.md)).
- Each tweak shows its text, then on its own row its memo count and, once it has been
  served, "served S" and "needed again M", as raw counts, never a ratio. Rewording a
  tweak restarts both counts ([memos](memos.md#tweaks)). No tweak shows an example.
- Each listed memo shows its medium, kind, time and summary; "You asked:" with its
  request's first line cut to 120 characters; one line with its AI, rounds, "N
  listed changes" (every row its memo page lists, formatting included, when it has any)
  and tier; the tweaks its report
  served (those still on file) and the tweaks it taught. Its first draft and final load
  only when that memo is opened.
- `/tps/memo/<id>` shows one memo in full: context; "You asked" with the request in
  full, a note that the AI is asked to keep only what the person typed and that it is
  shown only to them and never sent to an AI, and **Remove**; first draft or why there is none; final; "What changed"; served and
  taught tweaks; Forget. Another account's or an unknown id is a 404.
- "What changed" lists code's stored changes in text order, with no labels
  ([memos](memos.md#changes)). Each shows before → after, or `added:` or `cut:` when
  one side is empty. A Markdown-only spot says "formatting". A side cut at 300
  characters ends in "…" and the row says "shortened to 300 characters", so a cut is
  never hidden. A `too_large` memo says "Too many changes to list; the first draft and
  final above show them all."; an untouched final says nothing changed. The diff compares
  words and marks, so an edit of spacing or line breaks alone lists no row; the page then
  says only spacing or line breaks changed, never that nothing did. A memo saved
  before changes were listed, or without a kept first draft, has no "What changed".
  There is no typed share and no tweak line on a change.
- Under the list, a memo whose changes a report may serve (the report's own
  `servesChanges` and `servableRow`, [reports](reports.md#what-they-changed)) says "Your
  AIs may see a few of these changes when this memo is used as an example." "May",
  because which changes a report serves depends on its budget. Other memos say nothing.
- The cover sheet is shown read only, one ruled line per line as written, blank lines
  kept, with a note that an AI connected with Read and write changes it; an empty one
  says "No cover sheet yet." and how to start one. There is no cover sheet form
  (Peter, 2026-11-10; [memos](memos.md)).
- The person can forget one memo, remove a memo's request (`/tps/request/remove`,
  which returns to the memo with "Request removed."), and delete or reword a tweak.
- An empty TPS page links to the Connected AIs page and shows the shared setup prompt
  ([setup](setup.md)) to copy; an account with memos gets a shorter prompt for the next
  draft instead.
- Every TPS page change is a POST with the CSRF and Origin checks, then redirects back
  with a notice.
- Every TPS page change runs in its own transaction under the account lock
  ([saves](saves.md)): forgetting one memo, removing a request, Delete all memos,
  deleting or rewording a tweak, and the Keep memos switch.

## Memo settings

- `/account/memos` holds the **Keep memos** switch, on by default ([memos](memos.md)).
- "Delete all memos" asks on its own page (`/account/memos/delete`) and runs only with
  the confirming field ([deletion](deletion.md)).

## TPS.md

- `/download` returns the complete writing export as `TPS.md`, including when AI access
  is paused: the cover sheet, the tweaks with counts (most cited first; a served one as
  `- text (N memos; served S, needed again M)`), then every memo's final grouped by medium,
  newest first, each under its kind and date with its summary and, when it has one,
  `Asked:` and its request in a `~~~text` fence longer than any run of tildes in it, so
  Markdown shows it as literal text: no heading, list or inline HTML comes from it. First
  drafts and changes are not in it.

## Connected AIs

- `/assistants` shows the connection address and links to the setup guides.
- It lists bounded live native connections grouped by client and read/write access,
  and original incomplete disconnects; a full native page says the listing is
  incomplete. Disconnecting is in [deletion](deletion.md).
- It also lists connection keys and the key form ([accounts](accounts.md)).
