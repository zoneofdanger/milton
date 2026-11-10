# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 36.** Ids are never reused, so this counter survives deleting the newest item.

## MVP

Work that ships before sign-ups open widely. Use the product note's vocabulary (cover sheet,
reports, memos) and plain text on security screens and anything an assistant reads.

- [ ] #2 (server, med) **Try first setup with a real assistant.** A new account starts with an
      empty cover sheet and empty reports. Refresh connector discovery for get_cover_sheet,
      get_report, list_reports and create_memo. Run the setup script, show the complete draft,
      obtain approval, save, and confirm only after a successful reread. Verify a correction
      through exact_edits, a fresh-chat read, and the web download through the hosted service.
      Each actual draft needs Peter's approval before an account write. Saves are model-free
      since 2026-11-02; rerun after the first newcomer test account exists.
- [ ] #33 (site, high, founder)
      **Record the HN demo clip as an asciinema time-lapse.** Peter postponed the launch about a
      week (2026-11-09) to build the trail feature first. It shipped as memos on 2026-11-09
      (#76), so this is unblocked; record it now, and
      re-check the scenes against what the feature saves. Shape (about 50-75 s, one real run on a
      test account, each tool with its own CLAUDE_CONFIG_DIR / CODEX_HOME so Peter's real Milton
      connection is never used): Day 1 in Claude Code, a fictional "Sam" asks "Reply to my
      manager. He needs me in on Saturday. I can't."; the first draft is generic, Sam makes three
      fixes and approves, the AI offers to save, Sam says yes. Card: "# Two weeks and 9 approved
      drafts later" (real samples from earlier real sessions, not seeded text). Day 14 in Codex
      (or Muse): "Tell the team the printer says PC LOAD LETTER again."; the first draft is
      approved unedited. Close: "# Did you get the memo? Your AI already did." then
      "# meetmilton.com · 30-day free trial, no card". Say "AI", not "assistant". ⚠ Never show
      Sam asking "Did you get the memo?": the homepage promises the AI reads Milton unprompted.
      Original names only, no film characters. Label it "real run, typing automated, pauses
      trimmed" (asciinema idle limit) and disclose a best-of-N take. Record only after the
      real-assistant tests show unprompted reads and fewer first-draft edits as samples grow.
      Peter approves Sam's samples. Check the .cast for tokens and home-folder paths before
      publishing; self-host asciinema-player; put the one-line setup command under the player.
- [ ] #35 (server, low) **Accept a flattened create_memo memo before hashing.** In 7 of 20
      #80 setup runs (claude-sonnet-5-5, Claude Code 2.1.321, both arms) the first five saves sent
      `memo` as the final text, a plain non-JSON string, with `context` and `new_kind` beside it
      at the top level; the server refused each ("memo: expected object, received string,
      Unrecognized keys") and the retry with a nested memo worked. Read a string `memo` as
      `final` and move top-level `context`, `new_kind` and `kind_id` into it, in memoInput
      before the request hash, like #79's `[]`/`null` reading, so either shape retries as one
      request. Unambiguous: none of those keys exist at create_memo's top level. ⚠ Only when
      `memo` is a string that isn't a JSON object; mcp.ts parsedObjectArguments already unpacks
      JSON-object strings.

## After the MVP

- [ ] #6 (site, low, founder) **Give Milton a Hawaiian shirt on Fridays.** Deferred 2026-10-30:
      Peter rejected the shirt beside the folder and wants to revisit the idea later.
      Keep the ordinary folder. If resumed, Friday follows each visitor's local time zone;
      choose new artwork and check its readability at navigation-icon size first.

- [ ] #8 (ops, med, founder) **Get end-to-end evidence for the newcomer path.** Never rehearsed:
      sign up, connect an assistant, approve, first setup, save, fresh-chat read, correction,
      download. Also unanswered with evidence: why Milton over the assistant's built-in memory,
      and how reliably assistants offer and save what they should across clients. milton-eval's
      email before-and-after is the first piece; needs a fictional test account Peter provides.
      2026-11-08: the fictional account (`e2e@milton-test.invalid`, owner script
      `server/scripts/test-account.ts`) and a daily-runnable check (`server/scripts/e2e.ts`:
      browser sign-in, connection key, save, fresh read, correction, retirement) exist; see
      the hosting runbook. Still open: the fresh-chat read and download through real
      assistant clients, and cross-client evidence of what assistants offer and save.

- [ ] #11 (server, low) **Make the spend test independent of UTC midnight.** A store-spend test
      reads the current UTC day twice and fails when a run crosses midnight (seen 2026-11-03
      00:00Z on a parallel run; passes on rerun). Inject the clock or compute the day once.

- [ ] #13 (server, med, founder) **Optional learn-from-sent-mail step in first setup.** Decided
      2026-11-03, then parked the same day because people will not trust a new product reading their mail, even through the assistant's own connector: the assistant, with permission, reads about twenty
      recent sent emails through its own mail connector, proposes up to five of different kinds
      with the full text, and files only the approved ones as exact samples; Milton gets no mail
      access. Built and reviewed as merge f2ea867 (setup.ts question 6, test, README), reverted
      unreleased; reapply by reverting the revert, then run first setup on an empty test account
      through Claude Code with a mail connector (#8) before release.

- [ ] #23 (ops, low, founder) **Billing mailbox: accountspayable@meetmilton.com.** Decided
      2026-11-03: subscription and payment issues go to accountspayable@ (the Nina nod), a real,
      read mailbox, not support@. Create the alias when paid subscriptions launch, route it to
      whoever handles billing, and name it on the pricing section, the FAQ "Will I be charged"
      answer, and the subscription_required message. Until then it does not exist; the landing
      page's unread joke address is a different alias.

- [ ] #27 (server, low) **Give auth owner-script refusals clear codes.** apps/auth/scripts
      provision.ts, maintain.ts and migrate.ts throw plain `Error(message)` with no `code`, so
      `safeError` prints `UNCLASSIFIED` for every refusal and an operator can't tell causes
      apart (found in the 2026-11-07 cutover rehearsal). Give each refusal a stable code that
      safeError prints, without secrets. Also make provision.ts's "output outside the
      repository" check resolve the real repository root rather than only its own checkout.

- [ ] #30 (server, low) **Drop save_requests.source_hash and its check.** Since Drizzle 0006
      the column is nullable and saves no longer write it (audit 2026-11-07b, finding 12);
      nothing reads it. Unblocked 2026-11-10: after #78 nothing serves or rolls back below #76
      (`milton-*-memos-bdac60f`), and no revision since 0006 writes it. Generate a migration
      that drops the column and rewrites `save_request_hashes` to check `input_hash` alone (no
      CASCADE, with a
      rollback file and a runbook section), and remove the two raw test INSERTs' `source_hash`
      in server/test/store-saves.test.ts.

- [ ] #31 (server, low) **Take Stripe off sign-in and deletion after launch.** The
      narrowed follow-up to PR #67 took checkout's live read and the webhook off the row lock
      (compare-and-set on `trial_accounts.stripe_revision`, 0011, with a one-off `--resync`
      after its cutover) and deferred the rest. Sign-in still waits on Stripe, up to three
      5 s calls under `trial_accounts FOR UPDATE` (`whileWaiting`), so a Stripe outage is a
      sign-in 503; deletion's Stripe DELETE still runs inside its lifecycle transaction.
      Moving enrolment to the background failed two reviews (Astra). It needs a durable
      retry, and a retry sweep can starve behind accounts that keep failing; a sweep whose
      every account failed still answered HTTP 200, so the maintenance job's failed-execution
      alert would see nothing. A takeover can duplicate trials: Stripe prunes idempotency
      keys after 24 hours, and a 500 can take effect late, so neither proves a create failed;
      duplicate subscriptions can both charge once the customer has a default payment method
      (the trial's cancel-without-payment-method setting doesn't apply then). An enrolment in
      flight races deletion: deletion can find no customer, finish, and leave the customer and
      trial the enrolment then creates (main's own form of this race is fenced since #32's
      fix: no customer link once deletion has begun); a background design must keep that
      fence on every customer link, checkout's included. And old and new
      revisions overlap at cutover, with nothing enforcing a quiescent switch.
      The stale holder's lease overwrite and the ineffective fence regression test were
      retired with that design. Full argument: PR #67 (closed unmerged) and its
      description's Round 2 section.

- [ ] #34 (server, low, founder, blocked: Peter's two weeks of real memos use after #76)
      **Measure duplicate tweaks on Peter's account, report only.** Decided 2026-11-09
      (Peter): revisit the OpenAI Decisions API idea after his two weeks. A weekly job takes
      each tweak saved since its last run, shortlists the account's 10 closest tweaks by word
      overlap, and asks Decisions (gpt-6-luna, one Choice question) "the same as one of these,
      or none?". Report only: list what it would merge, change nothing. It sends Peter's tweak
      lines (never memo text) to OpenAI, so it needs his go on the day. Few duplicates: drop
      this item. Don't assume AIs reuse served tweak ids: on #76's first instructions none did
      (0 of 118 tweaks in qa's runs); after the Tweaks text rewrite (886e71c) Claude reused the
      id in the one repeat case qa reran. Many duplicates: the same job merges for real,
      only at probability 0.90 or more, never a reworded tweak, never across accounts, keeping
      the older text, logging each merge with undo on the TPS page, plus a privacy-page line.
      Offline test (2026-11-09, fictional, local-only notes in .agents/tmp/decisions-test):
      at 10 candidates, 70% of reworded repeats found against 19% for exact match, 0 false
      merges in 95 must-not-merge cases; at 50 candidates recall fell to 43%. About 330 ms and
      $0.0001 per tweak, which is why it runs weekly, off the save path. ⚠ Without the 0.90
      threshold it wrongly merged near-misses ("replies to clients" vs "support answers").
      Ranking with Decisions was tested too and rejected: no draft gain.

## From the audit of 2026-11-02 (`.agents/tmp/audit/report.md`)

- [ ] #19 (server, low) **Document two known limits.** Exact-edit anchors are not Unicode-normalized,
      so a quote typed with composed accents misses decomposed stored text (A26); the token's clock
      tolerance does not apply to expiry (A27). Both harmless today; write them into server/README.
