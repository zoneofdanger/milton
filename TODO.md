# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #6 (site, low, founder) **Give Milton a Hawaiian shirt on Fridays.** Deferred 2026-10-30:
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

- [ ] #9 (server, low) **Announce tool changes so clients refresh their schemas.** Found
      2026-11-02: a Claude Code session connected before the model-free release kept the
      old create_memo schema and sent rules as a string; the server refused it cleanly, but the
      first save from every stale client fails until it reconnects. Send the MCP
      notifications/tools/list_changed on connection resume after a contract change, and say
      "reconnect your assistant" in the invalid_input message when the shape is unknown.
