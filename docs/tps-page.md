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

What each change does to memos and their tweaks is in [memos](memos.md) and
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

- It reads in one statement: the Keep memos switch, the newest 200 memos (older ones
  stay in the export), each with its stored change rows, and the scoreboard
  ([memos](memos.md)).
- Each listed memo shows its medium, kind, time and summary; "You asked:" with its
  request's first line cut to 120 characters; one line with its AI and tier; and its
  tweaks, every stored change row as its memo page lists them (a `too_large` memo says
  there are too many to list). Its first draft and final load only when that memo is
  opened.
- There is no cover sheet section, no list of tweaks across memos, no reword form, no
  tweak score and no rounds; legacy cover sheets and notes are listed in TPS.md only
  (milton-overlord, 2026-11-12).
- `/tps/memo/<id>` shows one memo in full: context; "You asked" with the request in
  full, a note that it is the person's own words or the AI's one-line note when they
  only agreed, shown only to them and never sent to an AI, and **Remove**; first draft
  or why there is none; final; "Tweaks"; Forget. Another account's or an unknown id is
  a 404.
- "Tweaks" lists code's stored changes in text order, with no labels
  ([memos](memos.md#changes)). Each shows before → after, or `added:` or `cut:` when
  one side is empty. A Markdown-only spot says "formatting". A side cut at 300
  characters ends in "…" and the row says "shortened to 300 characters", so a cut is
  never hidden. A `too_large` memo says "Too many changes to list; the first draft and
  final above show them all."; an untouched final says nothing changed. The diff compares
  words and marks, so an edit of spacing or line breaks alone lists no row; the page then
  says only spacing or line breaks changed, never that nothing did. A memo saved
  before changes were listed, or without a kept first draft, has no "Tweaks".
- Under the list, a memo whose changes a report may serve (the report's own
  `servesChanges` and `servableRow`, [reports](reports.md#what-they-changed)) says "Your
  AIs may see a few of these changes when this memo is used as an example." "May",
  because which changes a report serves depends on its budget. Other memos say nothing.
- The person can forget one memo and remove a memo's request (`/tps/request/remove`,
  which returns to the memo with "Request removed."). Forgetting is the only delete.
  The retired tweak delete and reword routes and any cover sheet route are gone with
  their forms: a stale POST to one meets the browser router's not-found answer and
  changes nothing.
- An empty TPS page links to the Connected AIs page and shows the shared setup prompt
  ([setup](setup.md)) to copy; an account with memos gets a shorter prompt for the next
  draft instead.
- Every TPS page change is a POST with the CSRF and Origin checks, then redirects back
  with a notice.
- Every TPS page change runs in its own transaction under the account lock
  ([saves](saves.md)): forgetting one memo, removing a request, Delete all memos and
  the Keep memos switch.

## Scoreboard

- Per [memos](memos.md#scoreboard): the median change and the share accepted as-is, no
  rounds.
- Rollback limit, accepted (milton-overlord, 2026-11-12) as a degraded emergency
  fallback: the code before this release computes a median of rounds, and on an account
  with 10 or more scored memos in a mode whose odd-sized window has a row without rounds
  in the middle (NULL sorted as 0, ties in input order), its TPS page answers HTTP 503
  through the browser error handler; an even window misstates rounds (two NULLs give 0).
  No account meets it at release; one save after the release query can bring one into
  it. `server/scripts/check-compatibility.ts` reproduces it, and the query and rollback
  order are in [releases](deploy/releases.md).

## Memo settings

- `/account/memos` holds the **Keep memos** switch, on by default ([memos](memos.md)).
- "Delete all memos" asks on its own page (`/account/memos/delete`) and runs only with
  the confirming field ([deletion](deletion.md)).

## TPS.md

- `/download` returns the complete writing export as `TPS.md`, including when AI access
  is paused: `# TPS report`, then every memo grouped by medium, newest first (then by
  id), each under its kind and date with its summary, `Asked:` and its request when it
  has one, and its final quoted. Text from a memo that Markdown could read as structure
  goes in a `~~~text` fence longer than any run of tildes in it, so no heading, list,
  quote or inline HTML comes from it.
- Then its tweaks: every stored change row, formatting and edit-mode rows included,
  without the report's filters or budget, in order, as the report's `changeLine` prints
  it, under `Tweaks:` in such a fence. A cut row ends " … [shortened]", outside the
  quoted strings. A kept first draft whose changes were never recorded (before #109)
  says "Changes were not recorded for this memo."; an itemized memo with none says "No
  changes were listed."; a `too_large` memo says "Too many changes to list."; a memo
  without a kept first draft says nothing. First drafts are not in it.
- Then, only when present: `## Cover sheet (no longer used)` with the current version,
  and `## Earlier notes from your edits (no longer used)` with each legacy note's text,
  no counts, each fenced. Older cover sheet versions and historical save receipts stay
  stored until account deletion and are in neither view.

## Connected AIs

- `/assistants` shows the connection address and links to the setup guides.
- It lists bounded live native connections grouped by client and read/write access,
  and original incomplete disconnects; a full native page says the listing is
  incomplete. Disconnecting is in [deletion](deletion.md).
- It also lists connection keys and the key form ([accounts](accounts.md)).
