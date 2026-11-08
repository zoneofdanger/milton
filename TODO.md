# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 32.** Ids are never reused, so this counter survives deleting the newest item.

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

- [ ] #30 (server, low, blocked: rollback targets still write it) **Drop save_requests.source_hash
      and its check.** Since Drizzle 0006 the column is nullable and saves no longer write it
      (audit 2026-11-07b, finding 12); nothing reads it. Every app/MCP revision recorded as a
      rollback target before that release still INSERTs it, so dropping it now would fail their
      saves. Once no serving or rollback revision writes it, generate a migration that drops the
      column and rewrites `save_request_hashes` to check `input_hash` alone (no CASCADE, with a
      rollback file and a runbook section), and remove the two raw test INSERTs' `source_hash`
      in server/test/store-saves.test.ts.

- [ ] #31 (server, low) **Take Stripe off sign-in and deletion after launch.** The
      narrowed follow-up to PR #67 took checkout's live read and the webhook off the row lock (compare-and-set on
      `trial_accounts.stripe_revision`, 0010) and deferred the rest: sign-in still waits on
      Stripe, up to three 5 s calls under `trial_accounts FOR UPDATE` (`whileWaiting`), so a
      Stripe outage is a sign-in 503; and deletion's Stripe DELETE runs inside its lifecycle
      transaction. Moving enrolment to the background failed two reviews (Astra): it needs a
      durable retry, a takeover can duplicate trials (Stripe prunes idempotency keys after 24
      hours, and a 500 can take effect late, so neither proves a create failed), checkout's
      customer link bypassed a deletion fence, a retry sweep can starve behind failing
      accounts, and old and new revisions overlap at cutover. That last one applies to 0010's
      revision too: old writers don't advance it, so a quiescent cutover is still unenforced.
      Full argument: PR #67 (closed unmerged) and both of Astra's verdicts, posted on it at
      https://github.com/zoneofdanger/milton/pull/67#issuecomment-6726908897.

## From the audit of 2026-11-02 (`.agents/tmp/audit/report.md`)

- [ ] #19 (server, low) **Document two known limits.** Exact-edit anchors are not Unicode-normalized,
      so a quote typed with composed accents misses decomposed stored text (A26); the token's clock
      tolerance does not apply to expiry (A27). Both harmless today; write them into server/README.
