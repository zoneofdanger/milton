# Milton agent kit

Local building blocks for agents that represent a person. The kit does not call a
model, collect transcripts, send messages or save preferences. The caller owns its
authenticated Milton transport and decides when to act. Requires Bun for the CLI;
the library uses standard Node APIs and TypeScript source.

## Deliver current instructions

```ts
import { parseReport, upsertMiltonContext } from "@milton/agent-kit";

// Use an existing authenticated MCP connection for this person's account.
const report = parseReport(
  await mcp.callTool({ name: "get_cover_sheet", arguments: {} }),
);
messages = upsertMiltonContext(messages, report);
```

`parseReport` throws `MiltonReadError` on an access or read error; there is no
offline fallback and no cache. Read again for each task so a new version
takes effect.

Context replacement affects only developer messages marked `origin: "milton"` by
this adapter. It leaves the conversation intact and supplies every complete
instruction. Call `withoutMiltonContext` if
the fresh read fails. Supply the resulting messages to the model only after a
successful read; old context in an already-running request cannot be withdrawn.

`hookOutput(report, event)` wraps the same context for a client lifecycle hook; past
9,500 characters or UTF-8 bytes (`HOOK_CONTEXT_CEILING`) it sends the version, the
report index and an instruction to call `get_cover_sheet` instead, because Claude Code
files hook text over 10,000 characters and Codex spills it over about 10,000 bytes.

## Check objective rules locally

```sh
printf '%s\n' '{"text":"One two three.","scope":"routine_email","constraints":[{"scope":"routine_email","kind":"max_words","value":2}]}' |
  bun --no-env-file packages/agent-kit/src/cli.ts check
```

Exit 2 means a configured check failed; 0 means pass or `not_configured`; 1 means
invalid input. The JSON result distinguishes those states. Nothing is uploaded.
Scopes are `general`, `routine_email`, `formal_letter`, `slack_update`, `coding`.
Checks support whitespace word counts and case-sensitive required/forbidden literal
strings. A routine-email constraint does not silently apply to a formal letter.

The `dependencies` command compares before/after package manifests against an
explicit `allowedAdditions` list; omitting that list means unconfigured, while an
empty list permits no new dependency names. It does not audit upgrades or licensing.
The `manager` command checks `{choice, policy: {standingDefault, projectRequired}}`;
the project's explicit requirement takes precedence over the personal default.
The same functions are exported for use before sending or publishing an artifact.
No global output gate is installed and no typed constraint is inferred from prose.
These checks do not judge tone, relationship context, intent or human likeness.

## Correct and inspect

`prepareCorrection(report, {before, after, userDirected: true})` requires explicit
user direction and a unique current source anchor. It returns arguments for the
existing `create_memo` exact-edit operation, including the current expected version.
It never submits the save. Review the prepared edit, preserve its request ID when
recovering an uncertain response, and follow ordinary conflicts/first-setup approval.
The CLI command `prepare-correction` accepts the same fields on stdin.

Feed a cover-sheet response to `deliveryStatus` or the `status` CLI command to print
metadata only: the cover sheet version, whether the account is empty and the report count.
