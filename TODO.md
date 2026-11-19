# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 49.** Ids are never reused, so this counter survives deleting the newest item.

## MVP

Work that ships before sign-ups open widely. Use the product vocabulary (memo, tweak, cover
sheet, report, AI) and plain text on security screens and anything an AI reads.

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
      TPS.md download on `newcomer@milton-test.invalid` (PR #131). Codex CLI 0.167 (its own
      `CODEX_HOME`, a connection key, `codex exec`) passed the same path except the download.
      Codex refuses every `create_memo` until it is approved, because the tool is marked
      destructive (it also forgets). The setup page now gives the config lines. It put the
      standing line in the project's AGENTS.md, not `~/.codex/AGENTS.md` as /setup says,
      likely because of the run's sandbox; check that in interactive Codex. Still open:
      OAuth sign-in from a client, claude.ai and ChatGPT, interactive Codex, and
      cross-client evidence of what AIs save.

- [ ] #31 (server, low) **Take Stripe off sign-in and deletion after launch.** The
      narrowed follow-up to PR #67 took checkout's live read and the webhook off the row lock
      (compare-and-set on `trial_accounts.stripe_revision`, 0011, with a one-off `--resync`
      after its cutover) and deferred the rest. Sign-in still waits on Stripe, up to three
      5 s calls under `trial_accounts FOR UPDATE` (`whileWaiting`), but only at an account's
      first sign-in (or the next after a failed attempt): sign-in returns early once a
      subscription status is saved, so a Stripe outage is a 503 for new sign-ups, not
      returning users. Skipping the list call for a just-created customer is not safe while
      each call reads its own idempotency minute (2026-11-18, dropped); deletion's Stripe DELETE still runs inside its lifecycle transaction.
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

- [ ] #41 (server, low, founder, blocked: about 15 of Peter's memos showing one habit)
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
      Counted 2026-11-18 on Peter's 35 memos: 20 changed, but only one exact change
      recurred and no habit reached 15 examples, so the blocker is examples of one
      habit, not total memos.

## Agents find and set up Milton

Peter approved [the spec](docs/research/agent-discovery-spec-2026-11-19.md) on 2026-11-19:
agents should find Milton when a person says their AI doesn't write like them, and finish
setting it up on their own. Parts land in this order. Every line of copy is shown to Peter
as text before it ships, and every outside submission is his to make. No anonymous or
claimable accounts, and no copy that tells agents to route every complaint to Milton.

- [ ] #45 (site, med, founder) **Publish /agents.md, /llms.txt and a one-line prompt.**
      `/agents.md` is plain Markdown built from the same source as `/for-agents`, with
      setup for each AI (Claude prefill link, `claude mcp add`, `codex mcp add`, Cursor
      deeplink, VS Code, ChatGPT custom connector), then "call get_report". The prompt
      ("Set up Milton for me: read https://www.meetmilton.com/agents.md and follow it.")
      gets a copy button on `/setup` and the homepage; `SETUP_PROMPT` points at
      `/agents.md`. Founder: Peter approves the copy.

- [ ] #46 (server, med, founder) **Prepare Milton's Claude directory submission.** Audit
      the served instructions and tool descriptions against Claude's review criteria
      (nothing promotional or unrelated to the tools; the trial notice's link is the
      likeliest flag) and fix what fails; then prepare every field for Peter to paste at
      claude.ai/directory/manage. Founder: Peter submits from his Claude account.

- [ ] #47 (ops, low, founder, blocked: #46) **Publish Milton to the MCP Registry.** A
      `server.json` for `com.meetmilton/milton` with the HTTP proof at
      `/.well-known/mcp-registry-auth` on the site. Feeds aggregators, not Claude.
      Founder: Peter's go to publish.

- [ ] #48 (site, low, founder, blocked: #45) **Answer "Why doesn't my AI write like me?"**
      One honest page: what helps without Milton, where Milton fits, its limits as
      `/for-agents` states them. Founder: Peter approves the copy.
