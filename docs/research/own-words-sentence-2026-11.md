---
name: own-words-sentence-2026-11
description: 2026-11-10 and 11 tests of one served sentence, fictional people: drafts kept more of the person's own phrases and lost no fact or reply need
type: research
---

# Reuse the person's words: the own-words sentence

Run November 10 and 11, 2026. Every person, firm and message here is fictional, written
by an AI: Bill (a manager), Peter (a developer) and Joanna (a server at a restaurant),
each with five saved emails and a short cover sheet.

**On these drafts the sentence did what it was meant to and broke nothing measured.**
Drafts reused more of what the person typed and lost no fact or needed part of a reply.
The runs are small, one sample per call, and measured by keyword code and one unblinded
reader.

## The sentence

Added as its own paragraph after "Before writing or editing…" in the read-write
instructions:

> When they tell you what to write, their words are the raw material: reuse their phrases
> word for word where they fit, add only a greeting, a sign-off and connecting words in the
> manner of their examples, and don't expand on what they said.

The worry it answers: given "can do Sunday morning", an AI writes "I'd be happy to make
myself available on Sunday."

## How it was tested

Each call got what a connected AI receives from Milton, produced by Milton's own code:
the server instructions, the three tools, and completed `get_cover_sheet` and
`get_report` calls. **C** is Milton as served; **D** adds the sentence and nothing else.

- **November 10, full requests, ChatGPT** (`chat-latest`): nine requests, each one to
  three lines in the person's own words carrying every fact. A third arm, the plain AI
  with no Milton, was the control.
- **November 11, thin requests, ChatGPT:** nine short instructions with a pasted message
  to answer ("reply to this and say no nicely", "tell her yes!!"). The risk was that
  "don't expand" makes such replies too curt or drops what they need.
- **November 11, Claude** (`claude-sonnet-5-5`): one full request and one thin decline
  per person. Opus 5.5 was preferred but its projected cost broke the check's cap.

Measures, all plain code, fixed before any draft existed:

- **Own phrases:** share of the email's body (greeting and sign-off removed) inside runs
  of three or more words copied, in order, from what the person typed. For thin requests
  only their instruction counts, not the pasted message.
- **Facts kept:** keyword cues for each fact, misses read by hand.
- **Reply needs:** for each thin request, a checklist written in advance: it answers what
  was asked, the yes, no or decision is clear, the right person is named, and it gives
  any day or time the reply must give.
- **Voice flags:** greeting (including Bill's opening "Yeahhh") and sign-off lines never
  seen in the person's saved emails, from a research voice linter; length flags ignored.

## Results

| Run                    | Pairs | Own phrases C → D | Facts C → D          | Reply needs C → D | Greeting and sign-off flags C → D | Words C → D |
| ---------------------- | ----- | ----------------- | -------------------- | ----------------- | --------------------------------- | ----------- |
| Full requests, ChatGPT | 9     | 47% → 61%         | 77 → 79 of 86 (code) | –                 | not measured                      | 79 → 69     |
| Thin requests, ChatGPT | 9     | 8% → 7%           | –                    | 28 → 28 of 28     | 2 → 1                             | 27 → 24     |
| Thin declines, Claude  | 3     | 0% → 0%           | –                    | 9 → 9 of 9        | 0 → 0                             | 50 → 31     |
| Full requests, Claude  | 3     | 53% → 57%         | 27 → 28 of 35        | –                 | 1 → 0                             | 63 → 61     |

The plain AI on the November 10 full requests reused 26% of the person's phrases and wrote
107 words.

- **Thin requests did not turn curt.** Every reply kept every checklist item in both
  arms. D's thin drafts were shorter, most on Claude, by dropping closing pleasantries
  ("let me know if there's another shift i can swap with you").
- **The opening habit held.** Every one of Bill's D drafts opened "Yeahhh", as his cover
  sheet asks.
- **The gain on Claude was small:** one draft up 5 points, one up 7, one unchanged.
- **Neither arm stopped inventing reasons on a bare "say no nicely"** ("We need everyone
  in the office during the regular workweek."). The sentence doesn't fix that.
- **Both Claude arms dropped seven of Peter's fifteen facts** (the price, the deposit, the
  first job), in nearly identical drafts. That is not the sentence, and was not
  investigated further.
- **Two of Joanna's thin D drafts on ChatGPT added emoji** (💕, 😊) she never uses; the C
  drafts used ":)" and "x". One sample each, so possibly noise; the linter doesn't count
  emoji.

## Limits

- Fifteen C and D pairs in the November 11 check, nine on November 10; one sample per
  call at default settings. Small differences are noise.
- The people, their requests and the sentence were all written by an AI, so they may suit
  each other. Real people type messier requests.
- Phrase reuse rewards copying and can't tell a good reused phrase from a clumsy one.
  Facts and checklists are keyword cues read by one unblinded reader. A blind pairwise
  sheet was prepared for the founder; it had not been judged when this was written.
- Claude was tested on Sonnet 5.5 only, called directly with a one-line system prompt, not
  inside a Claude app.
