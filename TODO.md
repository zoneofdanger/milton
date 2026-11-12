# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 40.** Ids are never reused, so this counter survives deleting the newest item.

## MVP

Work that ships before sign-ups open widely. Use the product vocabulary (memo, tweak, cover
sheet, report, AI) and plain text on security screens and anything an AI reads.

- [ ] #2 (server, med) **Try first setup with a real AI.** A new account starts with an
      empty cover sheet and no memos. Refresh connector discovery for get_cover_sheet,
      get_report and create_memo. Run the setup script: paste about five pieces, kept as
      final-only memos, start the cover sheet in the person's words, then the standing line.
      Then draft, accept a final, check the one-line receipt, read again in a fresh chat,
      forget a memo, and download TPS.md through the hosted service. Each write to a real
      account needs Peter's approval. Saves are model-free since 2026-11-02; rerun after the
      first newcomer test account exists.
- [ ] #33 (site, high, founder)
      **Record the HN demo clip as an asciinema time-lapse.** Peter postponed the launch about a
      week (2026-11-09) to build the trail feature first. It shipped as memos on 2026-11-09
      (#76), so this is unblocked; record it now, and
      re-check the scenes against what the feature saves. Shape (about 50-75 s, one real run on a
      test account, each tool with its own CLAUDE_CONFIG_DIR / CODEX_HOME so Peter's real Milton
      connection is never used): Day 1 in Claude Code, a fictional "Sam" asks "Reply to my
      manager. He needs me in on Saturday. I can't."; the first draft is generic, Sam makes three
      fixes and approves, and the AI keeps the memo and shows its one-line receipt. Card: "# Two
      weeks and 9 approved drafts later" (real memos from earlier real sessions, not seeded
      text). Day 14 in Codex
      (or Muse): "Tell the team the printer says PC LOAD LETTER again."; the first draft is
      approved unedited. Close: "# Did you get the memo? Your AI already did." then
      "# meetmilton.com · 30-day free trial, no card". Say "AI", not "assistant". ⚠ Never show
      Sam asking "Did you get the memo?": the homepage promises the AI reads Milton unprompted.
      Original names only, no film characters. Label it "real run, typing automated, pauses
      trimmed" (asciinema idle limit) and disclose a best-of-N take. Record only after the
      real-AI tests show unprompted reads and fewer first-draft edits as memos grow.
      Peter approves Sam's memos. Check the .cast for tokens and home-folder paths before
      publishing; self-host asciinema-player; put the one-line setup command under the player.

## After the MVP

- [ ] #6 (site, low, founder) **Give Milton a Hawaiian shirt on Fridays.** Deferred 2026-10-30:
      Peter rejected the shirt beside the folder and wants to revisit the idea later.
      Keep the ordinary folder. If resumed, Friday follows each visitor's local time zone;
      choose new artwork and check its readability at navigation-icon size first.

- [ ] #8 (ops, med, founder) **Get end-to-end evidence for the newcomer path.** Never rehearsed:
      sign up, connect an AI, approve, first setup, save, fresh-chat read, forget, download.
      Also unanswered with evidence: why Milton over the AI's built-in memory, and how
      reliably AIs save what they should across clients. milton-eval's
      email before-and-after is the first piece; needs a fictional test account Peter provides.
      2026-11-08: the fictional account (`e2e@milton-test.invalid`, owner script
      `server/scripts/test-account.ts`) and a daily-runnable check (`server/scripts/e2e.ts`:
      browser sign-in, connection key, save, fresh read, forget) exist; see
      [the end-to-end check](docs/deploy/e2e.md). Still open: the fresh-chat read and download through real AI clients, and
      cross-client evidence of what AIs save.

- [ ] #11 (server, low) **Make the spend test independent of UTC midnight.** A store-spend test
      reads the current UTC day twice and fails when a run crosses midnight (seen 2026-11-03
      00:00Z on a parallel run; passes on rerun). Inject the clock or compute the day once.

- [ ] #13 (server, med, founder) **Release the optional find-sent-emails setup step.** Peter
      reopened it on 2026-11-10 ("go"), answering the 2026-11-03 worry that people won't trust a
      new product reading their mail: the AI offers it only when it already has a mail tool in
      that conversation and stays silent otherwise; it reads at most about 30 sent emails from
      the last 90 days, shows up to five in full and saves only the ones the person approves by
      number, exactly as shown; Milton gets no mail access. Served text and copy are on branch
      `agent/find-sent-emails` ([setup](docs/setup.md)). Before release, run one first setup
      through Claude Code on an empty test account with a test Gmail connected (#8,
      [the end-to-end check](docs/deploy/e2e.md)); Peter connects the mailbox. Check that the AI
      offered the step only with access, saved exactly what it showed and nothing unapproved.
      Once that passes, release, then fill the homepage onboarding row (`onboardingStep` in
      apps/site/src/pages/index.astro).

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
      Offline test (2026-11-09, fictional, local-only notes, not in the repository):
      at 10 candidates, 70% of reworded repeats found against 19% for exact match, 0 false
      merges in 95 must-not-merge cases; at 50 candidates recall fell to 43%. About 330 ms and
      $0.0001 per tweak, which is why it runs weekly, off the save path. ⚠ Without the 0.90
      threshold it wrongly merged near-misses ("replies to clients" vs "support answers").
      Ranking with Decisions was tested too and rejected: no draft gain.

- [ ] #36 (server, low, founder, blocked: a longer period of active users and usage)
      **Pool what people delete from AI drafts, opt-in.** Across accounts, count the phrases
      people remove between an AI's first draft and the final they accept. Plain code does the
      counting, and no person or model reads anyone's text. A phrase counts only once enough
      accounts have removed it that nothing particular to one person can appear. Two uses:
      sensible defaults for a brand-new account that has no memos yet, and a public write-up
      of what people delete from AI drafts. It needs enough active accounts and memos to mean
      anything, and Peter parked it until then (2026-11-11, of this idea, fifth on a list of
      five: "I think #5 can be a much later todo, after there has been a longer period of
      active users and usage."). Before any build: opt-in consent, a privacy policy change
      (apps/site/src/pages/privacy.astro), a check against
      [positioning](docs/positioning.md), and a spec. ⚠ It could cost trust, which is the risk.

- [ ] #37 (server, low) **Handle pool errors at integration test teardown.** CI's
      integration job sometimes passes every group and then crashes while stopping its
      disposable Postgres: an idle pool client throws an unhandled 57P01 ("terminating
      connection due to administrator command"). Seen twice by 2026-11-11 (#103 and #109);
      a rerun passed each time. Find which pool is still open when the cluster stops
      (`server/scripts/auth-integration.ts` ends its pools first, so check the pools it
      doesn't list and the `apps/auth` suite), then end it before the stop or give it an
      error handler. Don't swallow 57P01 while the groups are still running.

- [ ] #38 (server, low) **Enforce the typed request's line and paste rules in SQL.** A
      memo's kept request (#109) is limited to 600 characters, 12 lines and no pasted mail
      (a line starting `>`, an "On … wrote:" line, a From or Subject header). The database
      checks only the length and control characters (`memos_request`); the line and paste
      rules live in `server/src/store/save.ts` alone, so a future write path could skip
      them. Add a check constraint for both. It is a schema change: follow
      [migrations](docs/deploy/migrations.md), and check every stored request passes first.

- [ ] #39 (server, low) **Run the save's change check after the access gate.**
      `create_memo` diffs the first draft against the final (`checkMemo` in
      `server/src/store/save.ts`, called from `server/src/store/compiled.ts`) before the
      save reaches the trial gate and the account lock, so an account with no access can
      still make the server do that work. The cost is bounded by `changeList`'s own limits
      since #109 (worst case about 50 ms in its review), which is why this is low. Moving it changes which refusal such an account sees
      first, and refusals today come before any database work
      ([saves](docs/saves.md)): decide that order before building.

## From the audit of 2026-11-02

- [ ] #19 (server, low) **Document the token-expiry clock limit.** The token's 30-second clock
      tolerance does not apply to expiry (A27; `server/src/token.ts`). Harmless today; write it
      into server/README.
      <!-- retired-words: off: names the feature #76 removed -->
      (The exact-edit half of this item went with exact edits in #76.)
      <!-- retired-words: on -->
