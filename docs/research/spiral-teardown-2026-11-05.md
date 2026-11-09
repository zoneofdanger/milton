# Spiral: competitive teardown and style-guide reconstruction

Research date: November 5, 2026, Pacific time.

This note combines public product claims, a directly observed Styles dashboard, two user-supplied style guides, and a plausible implementation inferred from those materials. It is not recovered source code or an extracted system prompt. Account contents, private backups, credentials, and full source essays are excluded.

## Competitive scope and sources

Milton stores and retrieves approved examples and exact rules; the connected AI performs the writing. Spiral supplies its own writing process through its web app and generation tools. The useful comparison is the resulting writing and the effort required from the person.

- Spiral's [site and FAQ](https://writewithspiral.com/) describe samples, stylometry, editorial prompting, workspaces, and multiple drafts.
- Its [agent documentation](https://writewithspiral.com/agents) exposes generation, personalization, and humanization tools. Writing tools require a paid plan, while setup tools can work on free accounts. Access through MCP is therefore not a unique Milton feature.
- At the time checked, [pricing](https://writewithspiral.com/#pricing) listed Personal at $15/month and the wider Every bundle at $30/month. The approximately $5 Milton hypothesis should be compared with the $15 standalone product for someone already paying for an AI.
- Onboarding replies supplied by the user describe separate contextual styles and global Writing Rules, but no editor for an individual inferred observation. These are chatbot claims; the direct UI observation established the sample cards and analysis panel, not every claimed editing behavior.
- Free credits ran out during the initial exploration before a comparison draft was obtained. The user subsequently supplied a second style-guide output from another account and three writing drafts. The quota amount, reset policy, and precise credit consumption were not measured.

The proposed audience is people who want ordinary emails and messages to sound right inside an AI they already use. The hypothesis that they need less than Spiral's full workflow is untested. So is an 80–90% value or quality claim.

## Shared sample set

These are the user-supplied main essay bodies used in the pilot, with their supplied punctuation and paragraph breaks preserved in Milton. Counts use whitespace-separated words and exclude titles.

| Essay                    | Words | Source                                              |
| ------------------------ | ----: | --------------------------------------------------- |
| Write Simply             |   507 | [Paul Graham](https://paulgraham.com/simply.html)   |
| Being a Noob             |   371 | [Paul Graham](https://paulgraham.com/noob.html)     |
| Keep Your Identity Small |   689 | [Paul Graham](https://paulgraham.com/identity.html) |
| Total                    | 1,567 |                                                     |

The first Spiral import was observed directly as one sample and 507 words. The other imports were reported by the user; extraction identity and settings across accounts were not independently inspected. The author is familiar to many models, so this is a convenient pilot rather than a clean test of learning an unfamiliar person's voice. Essay samples also do not establish that person's actual email or DM style.

## Most likely mechanism

The sample set contains 1,567 words. A general language model can process all three essays together and produce a prose style guide. A separate statistics pass can produce the dashboard. The statistics might also be supplied to the guide-writing model, but the evidence does not establish that connection.

A plausible sequence is:

1. Store each sample's text and associate it with a style or workspace.
2. Compute word frequencies, punctuation counts, sentence statistics, and prose/list proportions for the dashboard. Normalize lexical counts per 1,000 words and compare with a reference distribution labeled typical AI.
3. Give a language model the sample texts and an instruction to extract a reusable writing guide: sentence structure, pronouns, punctuation, vocabulary, and tone. These headings could be prescribed or chosen by the model.
4. Produce both a short summary and the longer guide. One structured-output call could emit both; separate calls are also possible.
5. Store the generated guide for reuse in writing requests. Whether Spiral also passes the original samples during drafting is unknown.

No part of this small-input workflow requires fine-tuning a model. That does not establish which model Spiral uses or whether other product paths involve additional processing.

Spiral's [public FAQ](https://writewithspiral.com/#faq) describes using the same underlying models as other AIs, configured with its own editorial prompting.

## Dashboard numbers reproduced exactly

These reproductions concern the first essay, Write Simply, because that was the dashboard actually observed. They are not measurements of the later three-sample dashboard.

The essay contains 507 whitespace-delimited words. Tokenize ordinary English words while preserving contractions, then apply candidate word lists:

| Category     | Matching words and counts                                        | Total | Per 1,000 words | Divided by Spiral's displayed AI reference |
| ------------ | ---------------------------------------------------------------- | ----: | --------------: | -----------------------------------------: |
| Comparatives | more 5; most 4; easier 2; less 1; further 1; better 1; simpler 1 |    15 |            29.6 |                  6.6x, using 4.5 per 1,000 |
| Intensifiers | simply 5; so 2                                                   |     7 |            13.8 |                  2.8x, using 5.0 per 1,000 |
| Negation     | not 5; doesn't 2; can't 1; never 1                               |     9 |            17.8 |                 1.5x, using 12.0 per 1,000 |

All three rates and ratios match the observed UI after rounding. These are candidate lists that reproduce this input, not recovered exhaustive dictionaries. Another counting method could produce the same totals. The provenance and representativeness of the typical-AI reference remain unknown.

The counts also show a limitation of dictionary features. Five of the seven intensifier matches are the word simply, which is central to the topic of the essay. A count alone cannot decide how much this reflects enduring style rather than subject matter or the word's grammatical use.

## How the prose guide maps to the samples

| Guide feature                     | Evidence in the essays                                                                               | What the model appears to add                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Assertion followed by elaboration | Short claims followed by reasons, examples, and qualifications                                       | A universal three-part paragraph rhythm and instructions about how every paragraph should end |
| I, you, and people                | Directly observable pronouns used for personal observations, addressing readers, and generalizations | Recommendations about which viewpoint to default to in future writing                         |
| Plain vocabulary                  | Everyday words, contractions, and the repeated word noob                                             | A broader prescription about foreign terms and an implied permanent signature vocabulary      |
| Rhetorical questions              | Questions organize parts of the identity and noob essays                                             | A rule to always answer immediately and never leave questions hanging                         |
| Physical metaphors                | Food, a reader carrying a train, and a woodworker building a chair                                   | A preferred source domain for future metaphors                                                |
| Low em-dash use                   | One em dash across the supplied corpus                                                               | A total ban                                                                                   |
| Confidence with qualifications    | Phrases such as I think and if it's right                                                            | An instruction to assert despite uncertainty and avoid upfront hedging                        |

Some descriptions are reasonable readings. The crucial transformation is from observations about a few texts into instructions for future writing. Each instruction adds a choice about how broadly to generalize.

## Errors that expose the limits of the generation step

- The guide labels “No one would know what side to be on.” a four-word example. It has nine words.
- Its example for colons, “By definition they're partisan.”, contains no colon.
- Its quotation beginning “Politics, like religion” truncates the original sentence without marking the omission.
- Avoiding em dashes entirely is a stronger instruction than the supplied samples support: Keep Your Identity Small contains one.
- “Never build toward a conclusion when you can lead with it” sits awkwardly with the gradual exploration in Keep Your Identity Small. It could be editorial advice added by the model rather than an observed rule.

These errors are compatible with language-model synthesis without a successful final evidence check. They do not identify the vendor, model, number of calls, or exact prompt, and do not establish the quality of Spiral's final drafts.

## Two generated guides from the intended same corpus

The user supplied guide A after the first three-essay setup and guide B after adding the same three essays to another account. Both use the same five section headings and turn observations into imperative instructions. This is consistent with a reusable analysis template, but does not prove a fixed prompt or identify a model.

| Feature                | Guide A                                                                         | Guide B                                                              | What the supplied essays establish                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Em dashes              | “Avoid em-dashes entirely.”                                                     | “Use em-dashes to insert a sharp aside or reframe mid-sentence.”     | One em dash across 1,567 words; neither a blanket ban nor frequent use is established.                                       |
| Colon example          | “By definition they're partisan.”                                               | “Then it struck me: this is the problem with politics too.”          | The first example has no colon; the second is a real colon example.                                                          |
| Uncertainty            | “When uncertain, assert anyway and qualify inline rather than hedging upfront.” | Use “I think” for inference and label the best available hypothesis. | The prose contains explicit qualifications; their strength should remain conditional.                                        |
| Semicolons             | Favor short sentences over semicolons.                                          | “Avoid semicolons.”                                                  | One semicolon in the supplied corpus; a low frequency alone does not establish a ban.                                        |
| Short-sentence example | Calls a nine-word sentence four words.                                          | Labels a shortened quotation ending at “chairs,” a fragment.         | The latter source sentence continues “or writing.” and is complete. The excerpt does not establish a fragment-writing habit. |

This is evidence of different generated prescriptions under intended matching inputs. It is not a controlled estimate of randomness: exact imported bytes, insertion order, intermediate guide regeneration, account defaults, model choice, and prompt versions were not held constant or independently recorded. An incremental guide-update process is another plausible source of differences.

For Milton, the consequence is practical: an AI can propose analysis, while exact approved guidance can remain stable until the person changes it. This does not establish that either guide produces better or worse drafts.

## A plausible reconstruction prompt

This prompt is an independently written approximation of the behavior we observed. It is not Spiral's actual prompt.

```text
You are a writing-style analyst. Analyze the writing samples below and produce a reusable guide that another writer can follow to write in the same voice.

Describe how the prose is constructed: sentence openings and length, paragraph development, point of view, pronouns, punctuation, vocabulary, metaphors, tone, qualifications, humor, and endings.

Write the full guide as direct instructions. Make the advice specific and actionable, and illustrate observations with short examples from the samples.

Organize the full guide into these sections:
- Sentence Architecture
- Pronouns and Point of View
- Punctuation
- Vocabulary
- Tone and Emotional Range

Also produce a one-sentence summary of the style.

Return a JSON object with two string fields:
- summary
- full: the complete guide in Markdown

<samples>
[Insert the three exact approved essay texts, each in its own labeled block.]
</samples>
```

This could plausibly produce the observed type of output in one ordinary model call. Exact phrasing, examples, and quality would vary. It has not been tested against Spiral's guide for reproducibility.

## What this means for Milton

A connected AI can already read Milton's samples and perform this analysis on request. The analytical generation can happen in the AI the person uses, while Milton remains storage and retrieval.

The meaningful product question is whether an approved, derived guide helps that AI write better than the original samples alone. A guide can compress useful patterns, but can also add unsupported restrictions. Nothing in this reconstruction authorizes saving inferred rules automatically or changing Milton's model-free storage behavior.

A [ten-brief A/B pilot](pg-style-guide-ablation-2026-11-05.md) now compares samples alone with samples plus the fixed second Spiral guide. The model judge preferred samples alone overall on five briefs and the guide condition on four, with one unclear result. This establishes no clear overall benefit in that small run. Guide-only drafting, human editing effort, and reviewed-guide variants remain untested. No derived guide was saved to Milton by this experiment.

## Verification and limits

Local word-count and punctuation checks, quotation checks, and the three lexical reproductions completed with exit 0. Sentence statistics explored during the analysis used rough splitting and were not treated as an exact reconstruction of Spiral's sentence parser.

Unverified: Spiral's internal model, prompts, tokenizer, complete dictionaries, reference corpus, regeneration schedule, use of measurements in guide generation, and use of the guide versus raw samples during drafting.

## Writing comparison now available

The user supplied three Spiral essays for the shared tool-library brief after the initial credit limit. A Milton-assisted essay had already been recorded before either style guide or any Spiral essay was seen. All four outputs, the exact brief, checks, and limitations are preserved in [the writing pilot](spiral-tool-library-pilot-2026-11-05.md).

All four drafts meet the 300–400 word request. This is a small, unblinded pilot with different environments and unequal output counts. It does not establish a numerical quality ratio, price-value parity, or how an ordinary consumer ChatGPT session performs with Milton.

The next gate is a blind comparison using fresh contexts, matched approved samples, controlled writing guidance, and the same number of outputs. A later unfamiliar writer and real email/message tasks would test the intended audience more directly. No product change or automatic derived-rule save is proposed by these findings.

## Follow-up guide test

The isolated [guide A/B test](pg-style-guide-ablation-2026-11-05.md) completed 20 writing calls and 20 judgments across ten briefs, with both candidate orders. It found no clear overall advantage from adding the supplied guide. That model-judged result is separate from the four-output Spiral/Milton product pilot above and does not establish their relative quality.
