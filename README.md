# Milton

**Make your agents write like you.**

You bring what you want to say. Milton helps your AI write emails and messages in
your voice, using examples you approve. Start with messages you have already written;
keep the drafts you want your AI to learn from. Rules and all five reports remain supported.

I built Milton because I was tired of telling Claude to stop using em dashes for the 100th time.

Milton is named after Milton Waddams in Office Space, the collator: he keeps things in order and
hands over the right one.

A default-off private pilot can add a read-only guide inferred from every active
approved sample in each report. It requires explicit processing opt-in and an eligible
paid subscription or unexpired trial. A separate background worker sends those samples
and their approved context to Anthropic; saves still preserve exact approved source.
Guides are labeled interpretations, with freshness and failure status. Rules and requested
edit scope take precedence. Downloads contain approved rules and samples only.
See [guide operations](server/deploy/guides.md) for bounds, consent and service isolation.

## How it works

- **Tell Milton how you write.** Your connected assistant sends rules, corrections,
  removals and approved samples with `create_memo`. The assistant names the report for
  each new rule and sends its exact approved wording; Milton stores it as sent, with no
  model rewrite. Rules a save does not name remain unchanged. Samples are stored exactly
  as you approved them.
- **Read the cover sheet, then the report that fits.** `get_cover_sheet` returns the
  rules true of all your writing and an index of five reports: email, chat, post,
  document, and speech. `get_report` returns one report, samples first, then rules;
  `list_reports` returns all five. Reads make no model call. Assistants decide when to read and
  apply them; Milton does not guarantee their adherence.
- **See what's on file.** The app shows your current cover sheet and reports and
  downloads them as `TPS.md`. New accounts start empty. Connect your assistant,
  paste something you wrote and ask it to clean it up. Older examples are optional;
  each exact sample needs retention approval before saving. Samples work without rules.
- **Keep the filing internal.** Each rule is an instruction card that keeps its
  version history internally. The cover sheet and reports are a current snapshot
  with a version, not a second history or restore interface. A save updates the
  memos and the reports together.

The hosted service is at [meetmilton.com](https://meetmilton.com), in early access.

## Get started

1. Sign in at [app.meetmilton.com](https://app.meetmilton.com/login) with Google or GitHub.
2. Add `https://mcp.meetmilton.com/mcp` in your assistant's MCP or connector settings,
   then complete sign-in and approve the connection. Availability depends on the
   assistant and your plan.
3. Ask your assistant to read your Milton cover sheet and relevant reports, preserving
   existing guidance. An empty account offers setup once. Paste something you wrote
   and ask it to clean it up, or ask directly to add older examples. Candidate lookup
   needs your request and access your assistant already has. Review each proposed
   sample body and useful non-private context with private details replaced by
   placeholders, then approve exactly what it may keep. Milton needs no inbox connection.
4. For another writing task, give your assistant the facts for the next email or DM.
   It reads the relevant report and drafts. You can skip examples and still get help.
   Approving a draft or edit does not approve saving it; retention needs a separate yes.

Use **Connect an assistant** above the cover sheet for the connection address and a
prompt to copy. It starts expanded for empty accounts and stays available after
your first save.
To change your rules later, tell your connected assistant what to add, correct,
or remove. A successful save updates the internal memos and the reports together.

Your assistant also makes two offers while drafting with you. When you approve a
draft or edit, it asks once whether to save it as a sample, quoted
exactly as approved. When you make the same correction twice, it proposes a short
rule. Nothing is saved until you say yes, and a no is final for that draft.

For every rule correction or removal, your assistant submits exact before/after
replacements copied from the current report. Milton applies that wording without a
model rewrite and leaves the surrounding text unchanged. The assistant still needs
to preserve your intended scope and conditions; literal editing does not decide
what you meant. Missing, repeated or overlapping matches leave the report unchanged.

Approved samples keep a stable ID. Revising their text, context or classification adds
a complete immutable revision; removing one retires it explicitly. Reports and the
TPS.md download show current active revisions. There is no history or restore screen.
Assistants revise through `sample.sample_id`; `replaces` is no longer accepted.

Milton supplies usage instructions when your assistant connects, plus descriptions
for all four tools and their arguments. These explain when to read the cover sheet
and reports, how to run first setup, and how to save or recover an uncertain request. Clients decide how
to present that guidance to their models. If your assistant needs a persistent
reminder, add this to its custom instructions or project setup file:

> Before writing for me, read my Milton cover sheet and the reports that fit the
> task, and apply them. Save changes to Milton only when I ask.

### Optional session capture

Capture starts off. To opt in for **this conversation only**, tell your connected
assistant:

> For this conversation, at task completion, save explicit reusable standing
> instructions I give you to Milton. Compare my current Milton rules first and save only
> genuine additions, corrections or requested removals. Preserve their scope and
> conditions. Skip one-off requests, project facts and inferred preferences. Send
> only the extracted instructions, not our conversation or private details.
> If Milton is empty, show me the complete first draft and wait for approval.
> Stop capture when I ask.

To turn it off, say:

> Stop Milton session capture. From now on, save only changes I explicitly ask
> you to save. Keep the instructions already on file.

Opt-in lasts only for the current conversation; repeat it in a new conversation
or another assistant if wanted. Connecting Milton or approving a first draft does
not enable capture. These on/off instructions stay with the assistant and are not
saved to Milton. Stopping capture does not undo saves already submitted.

This uses the same MCP tools, with no hook or plugin prerequisite. Capture is
best effort: the assistant must call the tools, and Milton cannot inspect the
conversation or guarantee a save before the session closes. Client tool approvals
still apply; silent or nonblocking operation depends on the client. These are
assistant instructions, not a server-enforced consent setting. Cross-client capture
reliability has not yet been evaluated.

## What is here

- [`server/`](server/): the Hono MCP server and web app, with Vite-built assets and Node 26 LTS runtimes. Its three services (app, MCP and self-hosted auth with verified password/email, Google and GitHub) are live on Cloud Run; memos remain in PostgreSQL. Its README and [hosting runbook](server/deploy/README.md) describe operation, release and rollback.
- [`apps/site`](apps/site/): the Astro page behind `meetmilton.com`.
- [`packages/theme`](packages/theme/): Milton's design tokens, stylesheets, and contrast check.
- [`design/`](design/): Milton's portrait.
- [`docs/how-milton-works.md`](docs/how-milton-works.md): every piece of logic in Milton, one line each.
- [`docs/research/`](docs/research/README.md): dated experiments, evidence and product/source research, including the Honcho comparison.
- [`SPEC.md`](SPEC.md): the design notes and decisions, in the order they were made.

## Working locally

```sh
bun install
bun run check-types
bun test
bun run dev      # the site, through Astro
```

## License

[MIT](LICENSE), © 2026 Zone of Danger, LLC.
