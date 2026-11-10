---
name: memos-spec-2026-11-09
description: The memos-and-tweaks spec Peter approved on 2026-11-09 for the memos release (#76), with its reasons and rejected options; frozen
type: research
---

> Historical and frozen. This is the spec as approved on 2026-11-09, before it was built in
> #76. Where it differs from the concept files in `docs/`, those describe Milton as it is now.
> Published after a privacy check. Two pointers to internal working files were replaced with
> notes and the repository's formatter reflowed tables and emphasis; no other wording changed.

# Spec: memos and tweaks ("same fixes, every chat")

Status: draft for Peter's approval, 2026-11-09, by milton-trail. No code yet. Decisions marked
**Peter** come from his answers in the milton-trail tab (or relayed verbatim by
milton-overlord); decisions marked **trail** are mine, with the reason, and he can overturn any of them.
Prior art: internal notes, cited below as prior-art §1 to §4, not published.

## The answer in one paragraph

Every time you accept a final with any AI, Milton keeps a memo: the AI's first draft, your final,
and the tweaks your AI writes from what changed between them ("no warm-up opener in vendor
replies"). It does this without asking, and the AI confirms in one line. Your words in a final make
it an example the next AI imitates. You also write one short
cover sheet: your voice guide ("no em dashes", "sign off –P"). Next time, in any AI, Milton
assembles a report for that draft: your cover sheet, the best-matching examples and the tweaks
from similar memos. The TPS page shows the result: how many rounds and how much change your
first drafts needed, this month against last.

The bar (Peter): people should feel "oh yeah, I do this all the time, and now something keeps
track of it so I don't have to."

## Vocabulary (Peter)

- **Memo:** one piece of writing Milton keeps: the AI's first draft, the person's accepted final,
  and the tweaks between them ("I kinda like memo though even if it's not perfect"). It replaces
  "sample". Peter rejected "samples" and "trails".
- **Tweak:** one line about what the person made the AI change ("Your tweaks: no warm-up opener
  (4 memos) · 2–3 sentences for declines").
- **Cover sheet:** the person's own voice guide.
- **Report:** what Milton assembles for one draft. It's no longer one of five fixed buckets.
- **Example:** a memo's final as served to the AI. **Corrections:** what the person asks the AI to
  change between drafts. These are not stored; the tweaks carry their meaning.
- SPEC.md's definition changes from "a memo is anything sent to Milton (a rule, a correction or
  an approved sample)" to the definition above. `create_memo` now does what its name says.
- "Did you get the memo?" now means "have you read the writing I've settled on before?"
- Code may use other names internally (`trail`, `lesson`), but the AI's instructions use one word
  for each thing throughout. All user-facing copy says "memo", "tweak", "cover sheet" and
  "report", never "sample", "trail", "lesson" or "rule", and "AI", never "assistant".

## The problem it beats

Status quo (**Peter**: "same fixes, every chat"): you correct the same habits in every new
conversation and in every AI. Style files and AI memory are per-tool, describe a voice rather
than learn from your fixes, and nobody keeps them up to date. Milton today keeps only the final
(after a yes) and proposes a rule only after the same correction twice _in a conversation the
AI can see_, so cross-chat repeats are lost.

## How it fits together

```
cover sheet (you write it) ──────────────────── served first, every read
memo ──► your words in the final ────────────► example   (imitated word for word)
     └─► what changed, first draft → final ───► tweaks    ("vendor replies: no opener")
```

- **Memos are the one stored thing (Peter).** A memo has the first draft, the final and its
  tweaks. Writing you paste at setup, or "remember this email", is a memo with only a final.
- **Light by design (Peter: "distill it down to just storing the first draft and the final draft
  and the AI-summarized tweaks and only when the user accepts the final draft").** This is
  CIPHER's own input: one draft and the person's final (prior-art §1).
- **Your words go to examples, what you changed goes to tweaks (trail, following Peter's "weight
  by how much is yours").** What an AI should imitate is text you wrote. What it should learn from
  is what you made it change, even when the AI typed the final words.
- **The cover sheet is your voice guide (Peter: "something akin to a system prompt").** It's for
  short, hard things examples can't show: "no em dashes", "sign off –P", "never say 'circle
  back'", "US spelling". The only evidence is small: in Milton's delivery probe (8 matched probes,
  no retrieval, not a cover sheet), the exact instruction met the rubric 8 of 8 times, against 5
  of 8 without it.
- **No rules (Peter: "drop rules entirely").** The AI no longer proposes or files rules, and
  there's no rule-after-twice step. Supporting signals, all weak:
  - In CIPHER, one preference applied to every task did worse than none, on summarization (email
    not reported).
  - GBrain's always-loaded preferences page lowered GPT-6.1 Sol's instruction following from
    91.1% to 85.7%, though both overall deltas were within noise.
  - In our Paul Graham pilot, a model-written guide added no overall gain over examples.
- **No fixed buckets (Peter: "assemble per draft").** Medium (email, chat, post, document,
  speech) is one context detail on each memo, beside kind, audience and purpose. Milton assembles
  each report from all memos, with medium as a strong ranking signal. Nothing is misfiled, and a
  tweak learned in email can reach chat when nothing closer fits.

**Reading.** Before writing, the AI calls:

1. `get_cover_sheet`: the cover sheet, its version, memo and tweak counts, and `is_empty`;
2. `get_report` with an intent: a one-line situation, medium, audience and purpose, plus kind
   where known. It returns the examples, then the tweaks, and a `report_id`.
   - The description demands audience and purpose, because vague intents cost 0.26 nP@8 in the
     ranking test, and tweak matching depends on the intent too.
   - An empty report (a new account, or nothing similar yet) says so. The AI writes from the
     cover sheet and the request alone, and never claims to know the person's voice.

**Precedence when they disagree:** what you say now, then the cover sheet, then tweaks, then
examples. Nothing widens an edit's scope.

**Worked example.** On Monday in Claude you ask for a decline to a vendor. You say "shorter",
then "no opener", and approve. Memo 1 is kept with two tweaks: "declines: 2–3 sentences" and
"vendor replies: no warm-up opener". Its final was steered by you, so it serves as an example in
the middle tier. On Wednesday in Codex you ask for another vendor decline. Codex reads the cover
sheet ("sign off –P"), then a report that includes memo 1's final and both its tweaks, and writes
a short draft with no opener, signed –P. You accept it untouched. Codex says "Kept memo: vendor
decline, 0 rounds." Memo 2 adds no example (untouched AI text) and cites no tweaks (no
corrections). The TPS page shows the two rows side by side: "Mon, Claude: 2 rounds" and "Wed,
Codex: 0 rounds · served: no warm-up opener, 2–3 sentences". That's the demo.

## The cover sheet

- **One free-text document per person, written only by them.** They edit it on the TPS page, or
  tell their AI the exact words ("remember: no em dashes", "add to my cover sheet: …"). The AI
  never adds tweaks or its own inferences to it, and never offers to (**Peter**: "never
  auto-filled from tweaks").
- **Where a stated preference goes:** "remember…" or "add to my cover sheet" goes on the cover
  sheet. A correction during a draft ("no em dashes here") becomes a tweak on that memo.
- **From the AI, whole lines only (Fable review).** The AI can add a line or remove an exact
  existing line. It never resends the full text, which invites paraphrase drift, and it can't
  empty the cover sheet. Full rewrites happen on the TPS page's form.
- **Cap: 1,500 characters (trail).** Reason: it's served on every read and competes with
  examples, and a long always-loaded profile is what hurt GPT in GBrain's test. Over the cap, the
  save is refused with a message to shorten it.
- **Storage (trail):** one current text per account. Every save appends a version, nothing is
  overwritten, and a save carries the version it read (today's `expected_version` fence).

## What a memo holds

Kept word for word:

- **The first draft**: the AI's first version, exactly as shown to the person. In edit mode, that's
  the AI's first edit of the person's text.
- **The final**: the version the person accepted, including any hand edits.

Written by the AI:

- **Tweaks**: what changed between the first draft and the final, and why, from the person's
  corrections in the chat (see "Tweaks").
- **Context summary**: one placeholder-safe line about the situation and the text being replied
  to ("decline Thursday meeting from a vendor; their email asked for a 30-min call"). It stands in
  for the ask. Never the quoted email or thread itself (**Peter**: summarize the context; this also
  answers other people's text). Same rule as Gmail's training pipeline, which drops quoted and
  forwarded mail (prior-art §3).
- **Medium, kind, audience, purpose, mode and rounds:**
  - kind is a personal label ("vendor decline"), reused by id, and belongs to the account, not a
    report;
  - mode is drafting or editing;
  - rounds is a count of redrafts, as a number.

Milton records the client, the time, the score, the final's tier, and the `report_id` of the read
that preceded the draft. That id lets Milton show which tweaks were served, without relying on the
AI to self-report.

**Not kept (Peter):** intermediate drafts, the person's raw correction messages, the ask, and hand
edits as separate items.

- What that costs: the play-by-play, and the person's exact correction wording.
- Phase 2 can still regenerate tweaks from the first-draft-and-final pair.
- Reason: saving is one light call when the person accepts. The AI re-sends two texts, not every
  round.

**Fidelity rule (trail).** The first draft must be sent exactly as shown. If the AI no longer has
it verbatim (compacted context, very long chat), it sends `missing` rather than rebuilding it.
Reason: a paraphrased first draft makes the score measure the paraphrase.

**When a memo is saved (Peter: "only when the user accepts the final draft"):**

- **On acceptance:** the person approves the final, says it's done or that they'll send it, or
  copies it to use.
- **Untouched finals count:** memos with zero rounds are saved too, because they're the success
  signal.
- **Not saved:** abandoned conversations, writing the person says isn't in their own voice
  (drafting for a colleague, a template), or when they ask the AI not to.

**Edit mode counts equally (product direction).** An edit memo is the person's own text, edited,
so its final ranks in the top tier. Its tweaks are about over-editing ("kept my sign-off", "only
fix what I asked").

## Examples (finals served to the AI)

Each final gets a tier, which Milton sets at save from the memo's mode and its first draft:

| Tier                   | What it is                                                                               | Served?                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Your words**         | Setup pastes, "remember this" memos, and edit-mode memos (the person's own text, edited) | Yes, ranked first                           |
| **Steered by you**     | Drafting memos whose final differs from the first draft                                  | Yes, below your words, at most 3 per report |
| **Accepted untouched** | Drafting memos whose final equals the first draft                                        | No; scoreboard only                         |

Simpler than before, by necessity: with no intermediate drafts, Milton can't tell a hand edit from
a later AI redraft. So "your words" comes from the memo's source, not from token counting.

Reason: Baumler et al. 2026 (docs/research/writing-evidence-2026.md) found people rate AI drafts
they've edited as their own voice, while measured, those drafts sit closer to the model. Serving
untouched AI text as an example would teach the AI its own habits. The spec departs from its
prior art by serving "steered" finals at all: PROSE and Baumler support the person's own writing,
not mostly-AI text. That's why steered examples are capped at 3 per report, and the learning test
checks them.

**Ranking (trail; tune with the learning test):**

1. requested kind;
2. medium match;
3. tier;
4. today's signals: purpose and context overlap, full-text rank of the situation against
   summary and body;
5. recency;
6. id.

No deliberate variety rule: Milton's ranking test found a deliberate mix gave no gain (−0.037,
within noise; docs/research/sample-ranking-2026.md).

**How many: a size budget, no count (Peter).**

- Examples fill by rank until they reach 32 KiB, about 8k tokens. The top example is always
  served, even over the budget, so a long document still gets one.
- Ten short DMs fit; two long documents may be all a report gets.
- The 32 KiB starting point is a guess, and the learning test tunes it.
- Known risk: Milton's ranking test found four examples clearly worse than eight, so long-document
  reports that get fewer than eight are checked in the learning test.
- Finals over 128 KiB are kept in their memo but never served as examples.

## Tweaks

- **Written at save** by the person's own AI, in the same `create_memo` call. It compares the
  first draft with the final and uses the corrections it saw in the chat for the why. Each tweak
  is one line, at most 200 characters, stating the change and its condition where known ("vendor
  replies: no warm-up opener"). Only memos whose final differs from the first draft cite tweaks. Reason: an AI asked to cite what it "followed" would cite everything it
  was served, so counts would measure serving, not learning (Fable review). Milton runs no model
  in phase 1; it stores the bytes and counts citations.
- **Identity like kinds (trail).** `get_report` returns the served tweaks with their ids. The AI
  reuses an id when a tweak is the same and adds new text only when none fits. Before inserting,
  Milton also normalizes new text (case, spacing, trailing punctuation) and reuses an exact match.
  Reason: this counts repeats across chats and AIs without running a model.
- **The person controls them:** they can delete or reword a tweak on the TPS page. A reworded
  tweak keeps its citations.
- **Storage (trail):**
  - A `tweaks` table: id, account, text (at most 200 characters, never changed), and the time and
    client it came from.
  - A citations table: one row per memo-and-tweak pair. A tweak's count is its number of
    citations. Forgetting a memo deletes its citations, and a tweak with none is deleted.
  - A tweak has no situation of its own. It's matched through the memos that cite it.
- **Which ones are served (Peter: "from the matched memos").**
  - Take the 10 memos that best match the draft by the example ranking.
  - Serve the tweaks those memos cite, ordered by best match, then by citation count.
  - Ceiling: 10 tweaks.
  - Reason: CIPHER retrieved preferences from the 1–5 most similar past contexts and cut edits 73%
    on email, with a simulated GPT-4 user holding coarse preferences, not a real person
    (prior-art §1).
  - The 10s (Fable review; down from 20) keep always-on guidance short, the same concern used
    against rules. The learning test can raise them.
  - Printed as "Your tweaks", after the examples.
- **Known weak spots:**
  - Quality depends on the person's AI. In CIPHER, most failures came from inferring the
    preference (prior-art §1).
  - Near-duplicates in different words split the count.
  - The person doesn't approve tweak text.
  - A hard "never" stated mid-draft (not on the cover sheet) reaches a later draft only through
    matching memos.
  - Safety net: the first draft and the final are kept word for word, so phase 2 can regenerate
    and merge tweaks from the pair, as CIPHER does.

## Where the person sees and controls it

- **Receipt (Peter):** the `create_memo` call, plus one line from the AI after a successful save:
  "Kept memo: vendor decline, 2 rounds, tweaks: no warm-up opener." It asks no question. The line
  works in clients that collapse or hide tool calls, and it's the "something keeps track" moment.
  If a save fails, the AI says so.
- **TPS page:**
  - the cover sheet with its edit form;
  - the scoreboard;
  - one list of memos, newest first, each labelled with its medium and kind. Each row shows the
    rounds, the tweaks that were served for it (from its `report_id`), the tweaks it taught and
    its tier, and the full memo opens on demand. This list is the first thing that shows progress;
    the scoreboard needs more memos;
  - the person's tweaks with their counts, with delete and reword.
- **Forget a memo:** from that list, or by telling the AI ("forget that one"). It removes the
  memo and everything it produced: its example, its tweak citations (a tweak left with none
  disappears) and its scoreboard numbers.
- **Correct a memo's context:** fix the summary, medium, kind or details. A memo's words are
  never edited.
- **Account switch (trail):** "Keep memos" on the account page, on by default.
  - Off stops automatic memos; the person can still say "remember this" to save one.
  - It also offers "Delete all memos".
  - Reason: Grammarly and ChatGPT both delete learned data on opt-out (prior-art §2).
- **Retention (Peter):** memos are kept until forgotten, deleted with "Delete all memos", or
  removed with the account. There's no timer.
  - Reason: phase-2 analysis needs the full history.
  - If sensitive content shows up in memos, the fix is better stripping at save, not deletion.
- **Export:** `TPS.md` holds the cover sheet, the tweaks, and every memo's final grouped by
  medium. A full memos download, adding first drafts, is phase 1b.

## Scoreboard

Shown on the TPS page (**Peter**) and computed server-side, with no model:

- **Rounds:** the redraft count the AI reports at save. It's a self-reported number, so change is
  the headline figure and rounds supports it.
- **Change:** normalized token Levenshtein from the first draft to the final, divided by the
  longer of the two (PRELUDE's normalized cost, prior-art §4).
- **Display (Fable review: counts, not calendar windows):** medians of the first 5 memos against
  the latest 5, plus the share of first drafts accepted as-is. Example: "First drafts: 1 round,
  18% changed, 40% accepted as-is (your first five: 3 rounds, 46%, 0%)". It appears at 10 memos,
  so the two groups don't overlap. Once there are 60 memos, it compares the last 30 days with the
  30 before.
- **Draft memos and edit memos are scored separately**, because edit memos start from the
  person's text and change little, which would mask draft improvement.
- Final-only memos and memos with a `missing` first draft are left out.

The demo clip is the worked example: two memo rows side by side. The scoreboard is for week two.

## Surfaces and limits

- **Three tools (from four):**
  - `get_cover_sheet`: no arguments. Returns the cover sheet, its version, counts and `is_empty`
    (no cover sheet and no memos), plus the setup script while empty.
  - `get_report`: requires an intent. Returns the assembled report (examples, then tweaks), the
    served tweak ids, and the person's kinds index.
  - `create_memo` takes:
    - `memo`: first draft, final, tweaks and context, in one call;
    - `forget_memos`;
    - `memo_context`, a context correction;
    - `cover_sheet`: a line to add or an exact line to remove, with the version it read;
    - `report_id`, from the read before the draft.
      It loses `rules`, `exact_edits`, `moves`, `sample`, `sample_context` and `retire_samples`.
  - `list_reports` is removed. There are no aliases: pre-launch, AGENTS.md rules out compatibility
    shims.
- **Cover sheet web form:** a plain form with the existing CSRF and Origin checks, and the same
  version fence; pages still run no scripts. This ends "only AIs can save" for this one field.
- **One call per memo, no parts.**
  - The only size limit is the existing 256 KiB request cap, refused before auth as an abuse guard.
    A first draft and a final together rarely come near it.
  - A memo over the cap is saved as the final alone, with the first draft marked `missing`. The
    error's `next` line tells the AI to do that.
  - Finals over 128 KiB are kept but not served as examples.
- **Saves are atomic** as today, with receipt and replay unchanged.
- **Cross-AI:** memos save from any connected AI with write access, and reports serve to every
  AI. A read-only key can't save.
- **Setup:** when `is_empty`, the AI offers once to save writing the person pastes (each piece a
  final-only memo, top tier) and to start the cover sheet. Setup never reads an inbox.
- **Wipe, not migrate (Peter: "wipe all user data to keep things simple"; scope: writing only).**
  - The release deletes every rule, sample, sample revision, kind, receipt, audit row and derived
    guide.
  - It keeps accounts, sign-ins, connection keys, trials, Stripe state and the e2e test account.
  - It drops the sample, card, accepted-change, guide and fixed-report structures, and creates the
    memo, tweak, citation and cover-sheet tables. Every account starts empty and gets the setup
    offer again.
  - milton-duo runs it from the runbook: snapshot first, release the code that stops reading the
    old tables before the drop (AGENTS.md), and the drop names its code-stopped-by PR for
    `check-migrations`.
  - The release note tells the live accounts their writing was reset.
- **Deletion:** account deletion removes memos, tweaks and the cover sheet.
  `docs/deletion-inventory.txt` gains every new text column.

## Contract changes the build must make together

These say the opposite today and change in the same release:

- **SPEC.md:**
  - the vocabulary (lines 6–12);
  - fixed reports, cards and samples (lines 13–30);
  - one retention approval per sample (98–103);
  - session capture, the sample offer and rule-after-twice (172–193);
  - "saves are model-free" (13, 210), still true in phase 1.
- **MCP server instructions** (`server/src/mcp.ts`): the Samples, Rules, Corrections and Session
  capture paragraphs, "Save this as a sample?" and "never promise silent saves". They're replaced
  by the memo workflow, within 3,500 characters.
  - Budget (Fable's count): the instructions are at 3,420 of the 3,500 cap, and `create_memo`'s
    description is 3,065. Dropping those paragraphs frees about 1,500.
  - The new workflow needs: save on acceptance, first-draft fidelity and `missing`, tweak-id
    reuse, the receipt line, cover-sheet versus tweak routing, and forget.
  - The builder drafts and counts the text first, before any code. If it doesn't fit, it moves
    detail into tool descriptions and error `next` lines.
- **Tool descriptions** (`server/src/mcp-tools.ts`): `create_memo`'s "Do not save … inferred
  preferences" and "never the transcript" must say exactly what a memo may hold and keep excluding
  secrets and other people's text. Remove `list_reports`.
- **`docs/how-milton-works.md`**:
  - rewrite The four tools, Assembling documents, Saves and First setup;
  - remove the rule lines;
  - add Memos, Tweaks, Cover sheet and Scoreboard.
- **Privacy page** (`apps/site/src/pages/privacy.astro`, around lines 75–81): rewrite Samples
  as Memos. Say:
  - what a memo holds, and that it's kept by default without asking;
  - that it's kept until forgotten or the account is deleted;
  - the switch and the forget controls;
  - that the receipt depends on the client;
  - that other people's text is summarized, not kept;
  - and drop the rule mentions.
- **AGENTS.md:** the opening paragraph (cover-sheet rules, five reports, four tools, exact edits)
  and "Rules and samples change only through the person … after the person approves the exact
  text" no longer describe Milton. Keep the stop-first protections for builders (never save to
  Peter's account on your own initiative; nothing private in fixtures).
- **Site copy:** remove "approved, word for word" wherever it promises no save without a yes, and
  "four tools, one cover sheet, five reports" (`/for-agents`, home).
- **Checks:** `check-mcp` and `mcp.test.ts` (exactly four tools becomes three). The e2e check
  (`server/scripts/e2e.ts`) saves, revises and retires a sample, runs twice daily and alerts after
  13 hours without a run. It must switch to saving, reading and forgetting a marked final-only
  memo in the same release, or monitoring pages on day one.

## How we know it works

1. **Fidelity (qa, phase 1).** Run 20 scripted memos each on Claude Code and Codex, and compare
   each saved first draft and final with the transcript. Bar: 95% byte-exact or marked `missing`.
   - Also measure capture rate (memos saved ÷ drafts completed) and receipt-line rate. Bar for
     both: 90%.
   - In chat UIs people often copy and leave, which the AI can't see, so test those apart.
   - If fidelity or capture fails, the phase-2 fix is a Stop hook that captures drafts on Claude
     Code and Codex.
2. **Learning (qa, phase 1b).** Use a fictional writer with hidden preferences and the same
   briefs in random order, with examples and tweaks on and off. Measure median change and rounds
   at 0, 3 and 10 memos on Claude Code and Codex.
   - **Bar, set before running:** at 10 memos, median change is at most 60% of the 0-memo value
     on both.
   - **The tier rule:** also run with untouched finals served, and confirm drafts drift toward the
     AI's defaults.
   - **The cover sheet:** three stated "never" items, run once as mid-draft corrections (tweaks
     only) and once on the cover sheet. Bar: on the cover sheet, broken in no more than 1 of 10
     later drafts.
   - **The budget:** compare 16, 32 and 64 KiB on long-document briefs.
   - **Caveat:** prior work used simulated users only, so this is necessary but not sufficient
     (prior-art §4).
3. **Real use (Peter, two weeks).** Peter's own scoreboard. Watch for anchoring, where change falls
   because he accepts "good enough". Spot-check 10 finals blind against his own writing.

Phase 2 (a Milton-side model that merges near-duplicate tweaks and analyzes progression across
memos) starts only if test 2 passes and the tweak lists get noisy.

## Phases

- **Phase 1, about a week, at the tight end:**
  - the new tables and the writing wipe;
  - the one-call save path;
  - tiers and tweak citations;
  - the assembled report (ranking, budget, tweaks);
  - the cover sheet (save, web form, served first);
  - three tools, instructions and descriptions;
  - the TPS page (list, forget, switch, scoreboard);
  - privacy, SPEC and how-milton-works rewrites;
  - the e2e check;
  - the fidelity test.
- **Phase 1b:** the full memos download and the learning test.
- **Phase 2:** the Milton-side model, and capture hooks if fidelity fails.

## Open for Peter

Trail defaults you may want to change:

- the three tiers and where tier sits in ranking;
- "Keep memos" on by default;
- the 1,500-character cover-sheet cap;
- the 32 KiB example budget;
- the two 10s for tweaks;
- 3 steered examples per report.

An internal review by Fable is not published. Peter overruled its sample-carrying point (all writing is
wiped). After first choosing to keep every draft, he went further than Fable's cut: the memo is
first draft + final + tweaks, saved on acceptance.
