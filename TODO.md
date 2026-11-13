# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 43.** Ids are never reused, so this counter survives deleting the newest item.

## MVP

Work that ships before sign-ups open widely. Use the product vocabulary (memo, tweak, cover
sheet, report, AI) and plain text on security screens and anything an AI reads.

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
      [the end-to-end check](docs/deploy/e2e.md). 2026-11-13: Claude Code (Opus 5.5, its own
      profile, a connection key) passed first setup, save, fresh-chat read, forget and the
      TPS.md download on `newcomer@milton-test.invalid` (PR #131). Still open: OAuth
      sign-in from a client, other clients (Codex, claude.ai), and cross-client evidence of
      what AIs save.

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

- [ ] #40 (server, low) **Refuse a request that repeats the draft or final.** A memo keeps
      what the person typed to ask (#109), and the AI is asked to send only that. The server
      refuses mail-like lines and anything over 600 characters or 12 lines
      (`server/src/store/save.ts`), but it can't tell typed text from pasted text. Add one
      precise rule: refuse a request when a long run of it also appears word for word in the
      first draft or the final, which is a "here's my text, fix it" paste. Measure it first on
      the fake pastes from #109's scripted client test. Skip guesses about what "looks like"
      an instruction: a wrong guess refuses a good save. This is tidiness, not a privacy fix:
      it can't catch someone else's pasted email, which never appears in the reply. The
      protection there is what exists: the request is shown only to the person, never served
      and removable. ⚠ Kept requests are never served to an AI or pooled across accounts
      without a new decision from Peter (2026-11-11).

- [ ] #41 (server, low, founder, blocked: Peter's real memos, about 15 or more)
      **Craft rules automatically from recurring tweaks.** Peter, 2026-11-12: "i still feel
      like we should, over time, automatically craft rules for the user once we are confident
      enough - rather than having the user explicitly define them". When the same change
      keeps recurring across a person's memos, Milton states it as a rule and serves it on
      every draft; the person never writes or approves one and can only delete one. Plain
      code counts the stored changes at read time, so no tool changes and the server stays
      model-free. What the November 2026 offline tests on fictional people found: at five
      memos a person about one generated rule in four was junk and the gain over no rules was
      within noise, so "confident enough" needs volume (most habits 10 to 15 examples, a
      "never" about 20). Counting worked for how a person opens and signs off, punctuation
      and phrases they keep adding; it can't see tone or rules that depend on the reader. A
      line served at the top of a report with priority was obeyed about 97% of the time,
      while the same kind of line as a low-priority note did nothing. Cuts such as "no
      subject line" were right for everyone, so they are defaults, not personal rules.
      ⚠ Not tamper-proof: Milton sees only what AIs send, so a tricked AI could save
      made-up memos; thresholds lower that risk and can't remove it. Before any build: a
      spec, the rule and its cases reviewed first, and the test repeated on real memos.

## From the audit of 2026-11-02

- [ ] #19 (server, low) **Document the token-expiry clock limit.** The token's 30-second clock
      tolerance does not apply to expiry (A27; `server/src/token.ts`). Harmless today; write it
      into server/README.
      <!-- retired-words: off: names the feature #76 removed -->
      (The exact-edit half of this item went with exact edits in #76.)
      <!-- retired-words: on -->
