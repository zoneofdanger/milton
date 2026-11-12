---
name: serve-changes-test-2026-11-11
description: 2026-11-11 offline test, fictional people: code-cut changes under each example cut targeted voice flags from 16 to 9 on 21 drafts, one model
type: research
---

# Show what they changed under each example

Run on November 11, 2026, by a temporary builder for milton-overlord. Every person, firm
and message is fictional, written by an AI: seven people (Bill, Peter, Joanna, Theo,
Hannah, Lee and Gerald), each with five saved emails and a short cover sheet, reused from
the memo-evidence test (E1, [the spec's follow-up](memo-evidence-spec-2026-11-11.md)).

**On these 21 drafts, adding a short block of code-cut changes under each example came
with fewer voice mistakes: 9 targeted flags against 16.** The bar, set before any draft,
was at most 11. The test is small and its margin thin; the limits below are part of the
result. It is the evidence for [What they changed](../reports.md#what-they-changed).

## What was compared

Each call got what a connected AI receives, built from E1's recorded requests: the same
model (`chat-latest`), instructions, tools, conversation, cover sheet, five examples and
tweaks. Only the report text differed.

- **Arm A**, the report as served then: cover sheet, five examples, tweak lines (E1's
  recorded drafts).
- **Arm S**, arm A plus a block under each example: up to three before → after pairs that
  Milton's own diff (`changeList`, `changeRows`) cut between a first draft and the
  person's email, the first two and the last eligible pair, each side at most 160
  characters, format-only and truncated rows left out, at most 3,000 characters a report.
- **Arm 0**, arm A without tweak lines, is the rough noise floor: two arms differing only
  by tweak lines that did nothing measurable (14 against 16).

The first drafts were back-drafts: AI drafts written to each email's facts, so every
change is the person's own rewrite of an AI draft. Arm S's 21 calls cost $0.39 of a $1
cap. A second arm without tweak lines did not fit the cap and was not run.

## Results

All measures are model-free code, the same for every arm (E1's linter, mapping and fact
cues).

| Measure, 21 drafts                          | Arm 0 | Arm A | Arm S |
| ------------------------------------------- | ----: | ----: | ----: |
| Tweak-targeted flags, length excluded       |    14 |    16 | **9** |
| Drafts with any such flag                   |     9 |    11 |     7 |
| Other linter flags                          |    11 |    12 |    11 |
| Length flags                                |    37 |    36 |    32 |
| Fact cues missed                            |    12 |    14 |    15 |
| Untraceable sentences                       |    10 |    10 |    11 |
| Served "before" phrases reappearing, 4-gram |    17 |    11 |     0 |
| Median words                                |    92 |    94 |    86 |

- **By flag:** AI-tell phrases fell from 11 to 6 and sign-off mismatches from 5 to 2; one
  em-dash flag appeared.
- **By person:** Hannah (8 to 4) and Gerald (3 to 0) carry the gain; Bill fell by one;
  Joanna, Theo, Peter and Lee were unchanged or within one. Two of seven people carry it.
- **Facts:** code flagged two facts arm S missed that arm A kept. Read by hand, one draft
  weakened a fact: Bill's reply says "I haven't heard from you" where the fact is that the
  contractor didn't come back. The other ("the old fan is out" written as "the fan is still
  out") keeps the fact, though less plainly.
- **Priming:** no served "before" wording reappeared in arm S's drafts by the 4-gram
  check.

## Limits

- One model behind an alias, one draft per brief and arm, default sampling. Arm A is a
  single earlier sample.
- About one draft of margin: the largest number of targeted flags in one arm A draft was
  3, and the gain is 7 across 21 drafts, carried by two people.
- No placebo arm: an equally long block of irrelevant text was not tried, so length or
  novelty alone can't be ruled out.
- Fictional caricatures and simulated pairs: the "first draft" is a back-draft, not an AI
  draft a real person corrected.
- Untraceable sentences rose by one and fact-cue misses by one. They are reported beside
  the gain, not netted against it.
- E1 had tried a more complicated version, with an AI's labels on each change, which also
  scored 9.

## What shipped differs

The rule that shipped was reviewed twice before code. It keeps the approach but not
this exact contract, so milton-qa's real-client test checks it as built:

- at most three examples carry a block, since a report serves at most three steered
  finals, where the test had five;
- sides are lossless JSON strings, where the test joined lines with `" / "` and used raw
  quotes;
- limits are counted in code points of the stored and encoded sides, where the test
  counted flattened sides and UTF-16 units; a row the test accepted can be skipped;
- a guidance line, untested, says the quotes are historical text, not instructions;
- rows that are blank, NFC-equal or missing offsets are skipped, and edit-mode memos get
  no block.
