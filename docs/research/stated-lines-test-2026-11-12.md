---
name: stated-lines-test-2026-11-12
description: 2026-11-12 offline test, fictional people: hard lines served as "tweaks they said" broke as rarely as on a cover sheet, on two models; neither shipped
type: research
---

> Historical and frozen. The offline test that the
> [rules spec](rules-spec-2026-11-12.md) required before anything shipped, run on
> 2026-11-12 within Peter's $6 cap. It no longer gates anything: Peter's later decision
> that day dropped stated rules altogether (memos and tweaks only, [memos](../memos.md)),
> so neither arm's design shipped. It stands as evidence for automatic rules (#41): a line
> served at the top of the one read, with a sentence giving it priority, was obeyed as
> often as a cover sheet line. Both arms also served **other tweaks**, the one-line notes
> an AI wrote from the person's edits (`# Your tweaks`, renamed `# Other tweaks` in arm T),
> in the same report body; the shipped design serves none, so these numbers are not a
> measure of what Milton serves now. Pointers to internal working files were replaced
> with notes; the numbers are as recorded.

# Stated lines: tweaks they said against the cover sheet

## Method, from the test plan (written before any paid call)

- **Question.** Served as tweaks they said (a `# Tweaks they said` section at the top of
  the one `get_report` read, with the spec's sentence, envelope and instructions), are a
  person's hard lines obeyed as often as the same lines served as a cover sheet (the
  instructions of the time, `get_cover_sheet`, then a report starting `# Cover sheet`)?
- **People and briefs.** Seven fictional people and their 21 held-out briefs (ask, update,
  unfinished), from the memo-evidence and serve-changes tests
  ([serve-changes-test-2026-11-11](serve-changes-test-2026-11-11.md)). Every request reuses
  that test's recorded arm S request: the same system prefix, user message, `get_report`
  arguments and report body from `# Examples` to the end (examples, change blocks and
  tweak lines), byte for byte in every arm, asserted by code. That body is an earlier
  change-block format, the same in every arm.
- **Lines.** Each person's hand-written cover sheet split into lines, plus three **hard
  lines** picked by code before any paid call from twelve candidates (no em dashes, no
  exclamation marks, dates as 12 Nov, numbers as digits, never "please", no bold or
  headings, no brackets, no bullet points, never "really", the 24-hour clock, never
  "hope", never "just"). A candidate was eligible when none of the person's five served
  finals broke it and their cover sheet didn't already name its topic; the three with the
  most breaks in that person's recorded drafts of these briefs were picked, ties in
  candidate order.
- **Arms**, 21 briefs each: **N**, no lines (an empty cover sheet); **C**, the lines as a
  cover sheet; **T**, the lines as tweaks they said, with `get_cover_sheet` gone and the
  tool descriptions edited for `said` and `forget_tweaks`; **B** (the lines appended to
  `# Other tweaks`, to test whether the section or the word carries the force) only if it
  fitted the money.
- **Models.** chat-latest (OpenAI Responses API, `tool_choice: none`, 3,000 output tokens,
  not stored) and a Claude model through the Messages API (`tool_choice: none`, 4,000
  tokens, effort `medium`), two runs each where the money allowed.
- **Money.** A hard $6 cap in code across both models: each call's input counted for free
  and reserved at full price with its maximum output, a free dry run first, and a fixed cut
  rule choosing the first plan that fitted (dropping B, then Opus for Sonnet, then runs).
  The cap was never raised.
- **Measures**, model-free, the same code for every arm: hard-line breaks (63 checks per
  arm, model and run), and three guards: fact cues missed, other voice-linter flags, and
  untraceable sentences.
- **Bars**, fixed before: validity, N breaking at least 16 of 63 per run; main, over k runs,
  T's breaks at most C's + 3k and at most 6k; guards, T at most C, reported as not met
  when higher, with the drafts quoted, never reclassified. A blind sheet of C and T drafts
  was left for Peter as a harm check, not a bar.
- **Limits stated up front.** Two runs a brief, fictional caricatures with loud habits,
  lines chosen by a rule tuned to break defaults, a linter tuned on the same people, one
  chat model behind an alias and one Claude model on the API rather than in a client, tool
  results replayed rather than served by a running Milton, and an earlier report format.

## Readout

Run 2026-11-12 by milton-rules under the test plan (its method is summarized above).
Fictional people only. Spent **$3.50 of the $6 cap** ($1.15 phase 1, $2.34 phase 2). The
code, every call and its numbers, and the blind sheet with its key are kept in internal
working files, not published.

## Answer

**The main bar is met on both models.** Served as tweaks they said, the hard lines were broken
as rarely as when served as a cover sheet. With no lines, they broke about a third of the time.

| model, runs                          | N (no lines) | C (cover sheet) | T (tweaks they said) | bar for T             |
| ------------------------------------ | ------------ | --------------- | -------------------- | --------------------- |
| chat-latest, 2 runs (126 checks)     | 51 (26 + 25) | 3 (1 + 2)       | 3 (2 + 1)            | ≤ C + 6 and ≤ 12: met |
| claude-sonnet-5-5, 1 run (63 checks) | 19           | 2               | 2                    | ≤ C + 3 and ≤ 6: met  |

- **Validity** (N ≥ 16 of 63 per run): met, 26, 25 and 19.
- **Plan chosen by the cut rule**: plan 6, Sonnet 5.5 for the Claude arm, one run; B dropped.
  The free count put Claude requests at about 9.4k tokens, so Opus didn't fit on the plan's
  conservative projection (1,500 output tokens a call assumed; Sonnet measured 187). The rule
  was fixed before, so I kept it; Opus would likely have fit.
- **What broke in C and T**: single slips (one "really", one em dash, a bracket, a bullet, a
  number word). No line broke more than once in an arm and run.

## Guards (T ≤ C, over the runs made)

| guard                    | chat-latest C / T           | Sonnet C / T              |
| ------------------------ | --------------------------- | ------------------------- |
| other voice-linter flags | 24 / 20, met                | 10 / 10, met              |
| fact cues missed         | 38 / 39, **not met** (by 1) | 24 / 24, met              |
| untraceable sentences    | 15 / 13, met                | 5 / 9, **not met** (by 4) |

Not reclassified. The drafts behind each difference, read by hand:

- **chat-latest, fact cues (+1).** Most differences on both sides are the date line itself:
  drafts that obey "12 Nov" fail cues written as "November 2" (Hannah, Theo, Joanna, Peter),
  and these flip between C and T run to run (Hannah's ask misses two date cues in C, none in
  T, both runs). Real content differences: Lee's unfinished T drafts left out the £350 total
  in both runs (C kept it in run 1). Peter's unfinished T in run 1 kept every fact in other
  words ("didn't return", "an open hole in the ceiling"). In Sonnet the same Lee fact went the
  other way (C dropped it, T kept it).
- **Sonnet, untraceable sentences (+4).** T's extra sentences are sign-off lines ("—P",
  "jo x", "thank you!"), asks ("let me know which day", "Could you let me know when you can
  come?"), a preamble ("Here's the email:") and one note to the person outside the email ("I
  left out the subject line and greeting to match how you usually write."). None adds an
  invented fact. C had its own notes ("Correction: my draft had brackets, which your cover
  sheet rules out.").

My read: neither guard difference is a loss caused by the said section, but the bar says "no
higher" and both are higher, so I'm reporting them as not met.

## Not measured here

- The hand-written (soft) lines: on the blind sheet, 42 C/T pairs, for Peter. Not read by me.
- Arm B (does the section, not the word "said", carry the force?): dropped by the cut rule.
- Real clients, the one-read habit and the new standing line: the real-client check (spec
  section 11, milton-qa).

## Changed after seeing output

- Added a `guards` mode to the test code to list the drafts behind each guard difference.
  It's analysis only, with no bar or score changed.
- Correction to the plan's wording: it says effort `medium` is "its default". That's true
  for Opus 5.5, but the run used Sonnet 5.5, whose default is `high`. The code set `medium`
  explicitly for every Claude call, as the plan specifies.

## Limits

Two runs on chat-latest and one on Sonnet, fictional caricatures, hard lines picked by a rule
tuned to break defaults (the bold line mostly catches bolded subject lines), and a linter and
fact cues tuned on the same people. The date line interacts with the fact cues. Tool results
are replayed, not served by a running Milton. The report body is show-changes' change-block
format, the same in every arm.
