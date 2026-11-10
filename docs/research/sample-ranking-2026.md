---
name: sample-ranking-2026
description: November 2026 offline tests on fictional authors: labels plus full text shipped, embeddings were rejected, better picks did not write better drafts
type: research
---

# Sample ranking: what was tested and what it showed

Milton keeps every approved sample and serves eight per report, so something has to choose
them. Two offline tests in November 2026 compared ways of choosing. Both used fictional authors.
Nothing here touched a Milton account.

## The answer

Milton ranks with labels plus Postgres full-text search, and no model runs on the server.
Embeddings were tested twice and rejected. They found slightly better matches and did not write
better drafts, and they would add a model call to every read and send samples to a third party.

The larger result: **in both rounds, better selection did not produce better drafts.** Neither
ranked method measurably beat newest eight on writing. That may be a limit of the test rather
than a fact about real writing (see Limits).

## Methods

Each returned eight samples from the report the task belongs to.

- **A, newest eight.** A baseline only. The product has no newest-eight path; recency is the
  tie-break and the fallback.
- **B, labels plus full text.** Order by how many of the intent's audience and purpose match the
  sample's stored labels, then `ts_rank` of the situation line against context and body, with
  terms joined by OR, then newest, then id. This is what shipped.
- **C, embeddings.** Cosine similarity with gemini-embedding-001, 3,072 dimensions.
- **D, embeddings plus labels.** Label overlap first, then cosine.
- **E, AI picks.** The AI reads an index of id, date, and context line, with no
  bodies, and returns eight ids.
- **F, mixed picks.** E, asked for five closest and three that differ in audience or purpose.
- **G, four samples.** E's first four picks.
- **H, two stages.** B shortlists twenty, then E picks eight from those.

Retrieval never saw ground truth. A model labeled each sample blind, as a saving AI would,
and labeled each intent line blind, as a reading AI would. Ground truth was used only for
scoring.

## Measures

- **nP@8.** A returned sample scores 1 if it matches the situation's true audience and purpose, 0.5
  for one, 0 for neither. The mean is divided by the best possible eight, so 1.0 is a perfect
  choice.
- **Draft score.** The same model draft each situation from each method's samples, without knowing
  the method. Two blind runs of a stronger model scored voice and fit from 1 to 5 against the
  author's persona. The composite is the mean. All intervals are 95%, from a paired bootstrap.
- **Intent flavors.** Each situation was written plain, paraphrased, and vague. A vague line is a
  poor intent such as "reply to this", never a missing one.

## Round 1

One author, 150 samples, largest report 55, 40 situations (120 intent lines), 20 situations
drafted.

| Method | nP@8  | Plain | Paraphrased | Vague | Draft score |
| ------ | ----- | ----- | ----------- | ----- | ----------- |
| A      | 0.419 | 0.419 | 0.419       | 0.419 | 3.425       |
| B      | 0.806 | 0.877 | 0.868       | 0.672 | 3.563       |
| C      | 0.571 | 0.570 | 0.613       | 0.529 | 3.450       |
| D      | 0.820 | 0.882 | 0.905       | 0.674 | 3.500       |
| E      | 0.688 | 0.724 | 0.712       | 0.627 | 3.650       |
| F      |       |       |             |       | 3.612       |
| G      |       |       |             |       | 3.212       |
| H      | 0.750 | 0.812 | 0.763       | 0.675 |             |

- D beat B on paraphrased lines by 0.037 [0.003, 0.074].
- E's draft score was highest, within noise of B: +0.087 [-0.275, 0.450].
- **Four samples were worse than eight.** G trailed E by 0.438 [-0.725, -0.138]. It was the one
  clear draft result.
- A deliberate mix showed no gain: F - E was -0.037 [-0.362, 0.275].
- D beat C by 0.249 overall, so the labels did most of D's work.

## Round 2

Three authors, 1,500 samples, email reports of 250, 120 situations (360 intent lines), all drafted.
Queries were written on the authors' own topics. All new data, generated after the harness was
frozen.

| Method | nP@8  | Plain | Paraphrased | Vague | Share on topic | Draft score |
| ------ | ----- | ----- | ----------- | ----- | -------------- | ----------- |
| A      | 0.318 | 0.318 | 0.318       | 0.318 | 0.104          | 3.771       |
| B      | 0.695 | 0.795 | 0.753       | 0.536 | 0.149          | 3.717       |
| D      | 0.729 | 0.795 | 0.781       | 0.610 | 0.189          | 3.679       |

- **D - B on drafts: -0.037 [-0.179, 0.102].** The bar was +0.20. D won 52 situations, lost 60, and
  tied 8, though the two chose the same samples on only 14 of 360 lines.
- **B - A on drafts: -0.054 [-0.200, 0.094].** Any gain from B over newest eight is at most about
  0.09 of 5 on these authors.
- D's precision lead is real but small: 0.034 [0.015, 0.053], largest on vague lines at 0.074.
- By report, B beat A on chat and A beat B on document and post. Those were after-the-fact cuts on
  small groups, so they are leads only.

## How the rule changed

Round 1 required embeddings to beat B by +0.15 nP@8 and +0.20 on drafts. Before round 2, the
rule became drafts alone: +0.20, an interval excluding zero, and no author more than 0.20 behind.
There were two reasons. B's 0.87 left little room for a +0.15 precision win, and precision had
risen sharply with no measurable change in drafts. Precision here means label matching, so it
tends to favor the methods that read labels.

## Does an AI make a second call?

A menu design (method E) only works if the AI fetches what it picked. A local stub server
served rules plus an index first, then bodies on request, to fresh Claude Code runs on Sonnet 5.5.

| Runs                                     | First read | Second call before drafting |
| ---------------------------------------- | ---------- | --------------------------- |
| Prompted, result carries a `next` line   | 10 of 10   | 10 of 10                    |
| Prompted, tool description only          | 10 of 10   | 10 of 10                    |
| Unprompted, result carries a `next` line | 10 of 10   | 10 of 10                    |

AIs asked for two to eight samples, often fewer than eight, which the G result suggests
would hurt. The unprompted runs are weak evidence: Milton's were the only tools present, and it was
a stub. Nothing here covers ChatGPT or any other client. Hiding things behind a menu is known to
be risky: GBrain saw hidden-tool tasks fall from 96.9% to 46.9% with a shorter tool list, and from
87.5% to 5% on GPT.

If Milton ever needs a menu, a flat one tops out at a few hundred samples: at about 100 to 140
characters per line, 500 samples is near Claude Code's 50,000-character inline limit for a tool
result. B returns eight in one call at any size.

## Cost and speed of embeddings

Round 2 embedded 254,050 tokens. Query embedding from a laptop took a median of 180 ms and a p95 of
212 ms, added to every read. Google lists Gemini Embedding at $0.00015 per 1,000 "count". If that
means tokens, round 2's corpus cost about $0.04. Cost is not the objection.

## What vague intents cost

Plain to vague cost B 0.259 nP@8 [0.205, 0.314] and D 0.186 [0.138, 0.234] in round 2. Most of B's
loss comes from losing the labels: a blind model recovered both labels on only 9% of vague lines,
against 95% of plain ones. So the useful thing to ask of AIs is specific: name the audience
and the purpose. The served text does this.

## Limits

- **Fixed voices.** The authors follow literal voice rules in every situation, so any eight samples
  sound alike. Real people write differently to a client than to a friend, which is where choosing
  well should matter. This test cannot see that, and it is the main reason not to read these
  results as "ranking does not matter".
- **A model wrote the samples, and a model scored the drafts.** No human has confirmed a score.
- **Blind voice checks are easy here.** A check matched 45 of 45 samples to their author, partly on
  subject matter.
- **Stored labels were imperfect,** which is realistic: both labels were right on 67% of samples in
  round 1 and 52% in round 2.
- **One draw per cell,** one embedding model, and one drafting model.
- **Query times were not production figures,** and shipped B reads a stored search column that was
  not timed. Its result lists matched the tested SQL on every line of both rounds.

## Next

Test on real writing before spending more on ranking. Wait until an account has at least 100 email
samples, have a person mark which samples fit about twenty real situations, and repeat B against D.
Sending real samples to an embedding provider needs the account holder's approval first.
