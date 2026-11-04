# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 25.** Ids are never reused, so this counter survives deleting the newest item.

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

- [ ] #12 (server, low) **Break the store import cycle.** store/index.ts and compiled.ts import
      each other, now also through save.ts and save-apply.ts. Nothing reads those imports
      at load time, so it works today; a top-level use of utf8Bytes in a save module would crash
      startup. Move readLimits and utf8Bytes into a module with no store imports.

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
