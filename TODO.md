# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 29.** Ids are never reused, so this counter survives deleting the newest item.

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

## After the MVP

- [ ] #6 (site, low, founder) **Give Milton a Hawaiian shirt on Fridays.** Deferred 2026-10-30:
      Peter rejected the shirt beside the folder and wants to revisit the idea later.
      Keep the ordinary folder. If resumed, Friday follows each visitor's local time zone;
      choose new artwork and check its readability at navigation-icon size first.

- [ ] #7 (server, low) **Hash the sign-in subject in assistant_disconnects.** Shipped 2026-11-02
      in 0019 with the raw provider subject per refused (provider, subject, client_id), so the
      deletion fingerprint in deleted_identities adds little privacy. Store a one-way hash of
      provider:subject instead, keep the lookup on every MCP request, and migrate existing rows.

- [ ] #8 (ops, med, founder) **Get end-to-end evidence for the newcomer path.** Never rehearsed:
      sign up, connect an assistant, approve, first setup, save, fresh-chat read, correction,
      download. Also unanswered with evidence: why Milton over the assistant's built-in memory,
      and how reliably assistants offer and save what they should across clients. milton-eval's
      email before-and-after is the first piece; needs a fictional test account Peter provides.

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

- [ ] #25 (server, med, blocked: self-hosted auth cutover) **Let headless and background
      agents connect.** Scheduled or cloud agents (Claude Code routines, Codex cloud tasks, CI
      jobs, agent servers) have no browser and no one to approve consent, so OAuth sign-in
      leaves them unable to connect today. Plan (2026-11-07): connection keys created on the
      Connected assistants page and sent as a bearer header (Claude Code `--header`, Codex
      `bearer_token_env_var`, Cursor `headers`): read-only by default with saving opt-in,
      shown once and stored hashed, checked live on every call like disconnects. Expiry is the
      person's choice, including never (decided 2026-11-07, Peter); default to a set term. Ship
      key management UX with it, built from packages/theme: create with a name, scope and
      expiry; a list showing name, scope, created, last used and expiry (never-expiring keys
      clearly marked); revoke one key at a time. ⚠ The MCP server would then accept a second
      token type beside the strict native tokens: security review before release. Device
      sign-in (a code approved at auth.meetmilton.com/device; Better Auth has a plugin,
      unchecked against this build) keeps the native token model, but MCP clients lack it and
      it would need a `milton login` helper; consider it after keys. Update /for-agents when
      this ships.

- [ ] #26 (server, low, blocked: self-hosted auth cutover) **Simplify auth email to inline
      Resend sends.** Auth mail (apps/auth/src/mail.ts, migration 006, deliver.js) is a durable
      encrypted outbox with leases, fences, throttle pause, receipts, a once-a-minute delivery
      job and separate cleanup. Decided 2026-11-07 (Peter): keep it for the cutover, revisit
      after. Simpler target: send inline with a short timeout, one retry and Resend's
      idempotency key; log failures without addresses or links and alert on them; keep every
      public response identical whether or not the account exists (the AR-01/PR-04 account
      enumeration fix). Accept a rare lost email, which "resend" recovers. ⚠ This touches the
      security-reviewed sign-in path: needs an Astra review, and draining the queue and
      retiring the delivery job before switching.

- [ ] #27 (server, low) **Give auth owner-script refusals clear codes.** apps/auth/scripts
      provision.ts, maintain.ts and migrate.ts throw plain `Error(message)` with no `code`, so
      `safeError` prints `UNCLASSIFIED` for every refusal and an operator can't tell causes
      apart (found in the 2026-11-07 cutover rehearsal). Give each refusal a stable code that
      safeError prints, without secrets. Also make provision.ts's "output outside the
      repository" check resolve the real repository root rather than only its own checkout.

- [ ] #28 (server, low) **Retry the auth service's startup database check.** On
      2026-11-07 at 08:30:47Z a new `milton-auth` instance exited during startup:
      `checkRuntimeRole` gave up on its first connection ("Connection terminated due to
      connection timeout") while the Neon compute was waking from autosuspend. Cloud Run
      started another, but sign-in returned 503 for a few seconds. Autosuspend on the
      production endpoint was turned off the same day (`suspend_timeout_seconds: -1`), which
      removes the trigger. Still make the startup check retry with a bounded backoff (e.g. up
      to ~15 s) so a database restart or maintenance can't fail a cold start. Same review for
      app/MCP startup checks.

## From the audit of 2026-11-02 (`.agents/tmp/audit/report.md`)

- [ ] #15 (server, med) **Measure, then pool, database connections.** Each transaction opens its own
      Neon serverless client (A7, database.ts "no global connections", a Workers-era rule); one read
      is several HTTP queries and WebSocket connects. Measure latency first; if it pays, a process
      pool closed on SIGTERM.

- [ ] #19 (server, low) **Document two known limits.** Exact-edit anchors are not Unicode-normalized,
      so a quote typed with composed accents misses decomposed stored text (A26); the token's scope
      claim is parsed but never enforced and clock tolerance does not apply to expiry (A27). Both
      harmless today; write them into server/README.

- [ ] #21 (server, low) **Revisit the auth SDK after GA.** Revisit @neondatabase/auth 0.7.0-beta
      once GA (A21: React, Radix, Tailwind in the install).
