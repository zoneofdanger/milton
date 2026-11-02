# Milton

**Did you get that memo?**

Tell your assistant how you want things done. Milton automatically collates your
instructions, keeps the internal memos in order, and
prepares a TPS Report for your connected assistant to read. Useful with one
assistant or several.

I built Milton because I was tired of telling Claude to stop using em dashes for the 100th time.

Milton is named after Milton Waddams in Office Space, the collator: he keeps things in order and
hands over the right one.

## How it works

- **Tell Milton how you write.** Your connected assistant sends rules, corrections,
  removals and approved samples with `create_memo`. The assistant names the report for
  each new rule and sends its exact approved wording; Milton stores it as sent, with no
  model rewrite. Rules a save does not name remain unchanged. Samples are stored exactly
  as you approved them.
- **Read the cover sheet, then the report that fits.** `get_cover_sheet` returns the
  rules true of all your writing and an index of five reports: email, chat, post,
  document, and speech. `get_report` returns one report, samples first, then rules;
  `list_reports` returns all five. No model call. Assistants decide when to read and
  apply them; Milton does not guarantee their adherence.
- **See what's on file.** The app shows your current TPS Report and downloads it
  as `TPS.md`. New accounts start empty. For first setup, review and approve the
  complete draft before your assistant saves it.
- **Keep the filing internal.** Memos group complete instruction cards; cards retain their version history internally.
  TPS is a current compiled snapshot with a revision token, not a second history
  or restore interface. A save publishes memo changes and TPS together.

The hosted service is at [meetmilton.com](https://meetmilton.com), in early access.

## Get started

For context replacement in agent applications, local checks and correction
preparation, see the [agent kit](packages/agent-kit/README.md).

1. Sign in at [app.meetmilton.com](https://app.meetmilton.com/login) with Google or GitHub.
2. Add `https://mcp.meetmilton.com/mcp` in your assistant's MCP or connector settings,
   then complete sign-in and approve the connection. Availability depends on the
   assistant and your plan.
3. Ask your assistant to read TPS and help draft your working instructions. Use
   instructions you have explicitly shared or start with a few useful questions.
   Review the complete draft before approving its first save.

Use **Connect an assistant** above the report for the connection address and a
prompt to copy. It starts expanded for empty accounts and stays available after
your first save.
To refine your instructions later, tell your connected assistant what to add,
correct, or remove. A successful save updates the internal memos and TPS together.

Your assistant also makes two offers while drafting with you. When you approve a
draft to send, post, or say, it asks once whether to save it as a sample, quoted
exactly as approved. When you make the same correction twice, it proposes a short
rule. Nothing is saved until you say yes, and a no is final for that draft.

For every correction or removal, your assistant submits exact before/after
replacements copied from the current report. Milton applies that wording without a
model rewrite and leaves the surrounding text unchanged. The assistant still needs
to preserve your intended scope and conditions; literal editing does not decide
what you meant. Missing, repeated or overlapping matches leave the report unchanged.

Milton supplies usage instructions when your assistant connects, plus descriptions
for both tools and their arguments. These explain when to read TPS, how to run
first setup, and how to save or recover an uncertain request. Clients decide how
to present that guidance to their models. If your assistant needs a persistent
reminder, add this to its custom instructions or project setup file:

> At the start of a conversation, read my Milton TPS Report and apply the
> instructions relevant to the task. Save changes to Milton only when I ask.

### Optional session capture

Capture starts off. To opt in for **this conversation only**, tell your connected
assistant:

> For this conversation, at task completion, save explicit reusable standing
> instructions I give you to Milton. Compare current TPS first and save only
> genuine additions, corrections or requested removals. Preserve their scope and
> conditions. Skip one-off requests, project facts and inferred preferences. Send
> only the extracted instructions, not our conversation or private details.
> If TPS is empty, show me the complete first draft and wait for approval.
> Stop capture when I ask.

To turn it off, say:

> Stop Milton session capture. From now on, save only changes I explicitly ask
> you to save. Keep the instructions already on file.

Opt-in lasts only for the current conversation; repeat it in a new conversation
or another assistant if wanted. Connecting Milton or approving a first draft does
not enable capture. These on/off instructions stay with the assistant and are not
saved into TPS. Stopping capture does not undo saves already submitted.

This uses the same two MCP tools, with no hook or plugin prerequisite. Capture is
best effort: the assistant must call the tools, and Milton cannot inspect the
conversation or guarantee a save before the session closes. Client tool approvals
still apply; silent or nonblocking operation depends on the client. These are
assistant instructions, not a server-enforced consent setting. Cross-client capture
reliability has not yet been evaluated.

## What is here

- [`server/`](server/): the Hono MCP server and web app, with Vite-built assets and Node 26 LTS runtimes. Sign-in is Neon
  Auth (Google and GitHub); memos live in Neon Postgres. See its README to run your own.
- [`apps/site`](apps/site/): the Astro page behind `meetmilton.com`.
- [`packages/theme`](packages/theme/): Milton's design tokens, stylesheets, and contrast check.
- [`templates/`](templates/): the empty TPS template for new accounts.
- [`design/`](design/): Milton's portrait and icons.
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
