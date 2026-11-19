---
name: agent-discovery-spec-2026-11-19
description: The spec Peter approved on 2026-11-19 for agents to find Milton when a person says their AI doesn't write like them, and set it up alone; frozen
type: research
---

> Historical and frozen. This is the spec as approved by Peter on 2026-11-19 ("approve",
> typed in coordinator session milton-d2), before any of it was built. Where it differs
> from the concept files in `docs/`, those describe Milton as it is now ([site](../site.md),
> [setup](../setup.md)). Each part's copy and every outside submission still need his go.

# Spec: agents find and set up Milton (approved by Peter, 2026-11-19)

## Problem

People reach for a fix when their AI "doesn't sound like me", and more and more of them
ask the AI itself. An agent can only recommend a tool it can find, and only finish setting
one up when the steps are written for it. Milton today has a human setup page (`/setup`,
with a copyable prompt), an agent briefing in HTML (`/for-agents`) and a connector
reference (`/tools`), but no listing anywhere an agent looks and no plain-text setup an
agent can follow end to end. Peter, 2026-11-19: copy MotherDuck's agent setup, not its
anonymous accounts, and help agents choose Milton when people complain about their AI's
voice.

## What we learned (2026-11-19; sources in the session's research, rechecked before building)

- **Claude's connector directory is the only listing that reaches people mid-chat.**
  Listed connectors are eligible for Claude's in-chat suggestions; custom connectors and
  the official MCP Registry are not ("doesn't surface your server in Claude"). Submission
  is from a paid Claude plan at claude.ai/directory/manage: OAuth, every tool with a
  title and a read-only or destructive hint (Milton has both), documentation, privacy
  policy, support contact and icon. An automatic scan lists it as Community; Anthropic
  may later ask for test access for Verified. Grounds for rejection include tool text
  that tells Claude to do things unrelated to the tool or promotes products, and
  collecting conversation data beyond what the tool needs.
- **ChatGPT's directory costs more and conflicts with our trial notice.** It wants
  identity and domain verification, a test account without MFA, 5 positive and 3
  negative test cases and a video; and a listed app must not show plans or link to
  checkout, which our served trial-ending notice does.
- **The official MCP Registry is preview and feeds aggregators**, not Claude. Publishing
  needs a domain proof on meetmilton.com (DNS TXT or `/.well-known/mcp-registry-auth`).
- **llms.txt alone is rarely read.** Ahrefs (2026-06): 97% of llms.txt files got no
  requests in a month; agents fetch them when pointed at them.
- **Prior art:** MotherDuck ("ask your agent to fetch new.motherduck.com"), Neon's
  claimable Postgres and Vercel's claimable deployments create accounts agents can claim
  later; Clerk and Supabase publish copyable prompts. **Spiral** (Every, from $15/month)
  is agent-native since June 2026: MCP, an `agents.md` with setup per client (Claude
  prefill link, Cursor deeplink, VS Code, Codex, ChatGPT), and an llms.txt telling agents
  to send text to Spiral whenever a user says it sounds AI-generated. Jasper is in
  Claude's directory on brand voice. `ai.plainvoice/mcp` ("Rewrite AI drafts so they
  sound like you") is in the MCP Registry.
- **Our own earlier attempt:** a listing through Muse's connector portal (2026-11-05/06)
  stopped at two required reviewer accounts and Muse's OAuth client document failing
  Neon Auth's validation. Auth has since moved to Milton's own service.

## Change

Three parts, in this order. Each part's copy is drafted for Peter's approval before it
ships; every outside submission is Peter's to make.

### 1. Agent setup an agent can finish

- **`/agents.md`**, plain Markdown served from the site, built from the same source as
  `/for-agents` so the two cannot drift. It holds, for each client: the Claude prefill
  link (`claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Milton&connectorUrl=…`,
  replaced by the directory link once listed), `claude mcp add --transport http milton
https://mcp.meetmilton.com/mcp`, `codex mcp add`, the Cursor install deeplink, the VS
  Code command, and ChatGPT's custom-connector steps. Then one instruction: after sign-in,
  call `get_report`; the served setup script takes it from there.
- **One line people paste:** "Set up Milton for me: read https://www.meetmilton.com/agents.md
  and follow it." Shown with a copy button on `/setup` and the homepage; the existing
  `SETUP_PROMPT` points at `/agents.md` instead of `/setup`.
- **`/llms.txt`**, a short index pointing at `/agents.md`, `/for-agents` and `/tools`.
  Cheap; not relied on.
- Not in scope: anonymous or claimable accounts (decided 2026-11-19: the payoff needs
  memos, the data is private writing, and it would bypass sign-up protection).

### 2. Listings where agents look

- **Claude's directory first.** Before submitting, audit the served text against the
  review criteria: the instructions' directive lines (call `get_report` before drafting,
  save without asking, the trial notice's link) are about the tool's own function, but
  the trial notice is the likeliest flag; decide whether a listed connection serves it.
  Prepare every field (description, icon, links, support address, the policy
  acknowledgments) for Peter to paste; he submits from his Claude account. If Anthropic
  asks for Verified test access, the fictional e2e account's pattern is the model for a
  reviewer account, provisioned only on Peter's go.
- **MCP Registry second:** a `server.json` for `com.meetmilton/milton` with HTTP proof
  served from the site. Publishing is Peter's go.
- **ChatGPT deferred** until the trial notice question is settled and the test cases and
  video are worth the effort; `/agents.md` covers ChatGPT's custom connectors meanwhile.

### 3. Answer the complaint in its own words

- One human-readable page (working title `/sound-like-you`) answering "Why doesn't my AI
  write like me?" plainly: AIs default to a generic register; what helps without Milton
  (paste a few things you wrote, keep a style file, tell it what you changed); and where
  Milton fits (it keeps what you accepted and what you changed, across AIs). It states the
  limits `/for-agents` already states (no measured result yet) and never tells an agent
  to route every complaint to Milton. Agents that search the web cite pages that answer
  the question honestly; Spiral's "send everything to us" line is what we avoid, and
  both directories reject that kind of broad triggering.

## How we'll know

- **New accounts by AI client:** each approval already records the AI client that
  connected, so first-connection counts by client before and after each part ship need
  no new tracking.
- **Copy clicks:** a Vercel Analytics event on the new copy button, as the try-it folder
  already sends.
- **Fetches:** Vercel's request log for `/agents.md` and `/llms.txt`.
- Read monthly; no claim on the site until there is a number.

## Risks

- Directory review rejects the served instructions as directive. Mitigation: the audit
  above, before submitting, not after.
- A listing brings people whose first payoff is several memos away; the served setup
  script (about five pastes) is what closes that gap, so its path from `/agents.md` needs
  one rehearsal end to end on a fictional account (ties to #8).
- Spiral is ahead on agent setup and price-led features. We compete on honesty and on
  "what you changed", not on claims.

## Decisions for Peter

1. Approve this spec's three parts and their order.
2. Submit to Claude's directory from your account once the prepared fields are ready.
3. Publish to the MCP Registry (domain proof on meetmilton.com), or skip for now.
4. Approve the copy: `/agents.md`, the one-line prompt, the new `SETUP_PROMPT` and the
   `/sound-like-you` page, each shown to you as text before it ships.
