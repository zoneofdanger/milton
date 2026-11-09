# Writing style: what the evidence supports

Notes behind Milton's setup quiz and its evaluation, from November 2026. For how samples are
chosen, see [sample-ranking-2026.md](sample-ranking-2026.md).

## What the papers show

Three recent papers were read in full. Each is narrower than its headline.

- **Wang et al. (2025), [Catch Me If You Can? Not Yet](https://arxiv.org/html/2509.14543v1).**
  Giving a model five samples roughly doubled top-5 author attribution on Enron email (GPT-4o: 28.6%
  to 59.7%). Two samples matched ten, and samples on the same topic as the task hurt badly (69.3%
  to 36.0%), which the authors put down to narrower range. The caveats are real: a classifier
  trained on those authors, scoring topic and style together; 2001 corporate email averaging 309
  words; and no test of one sample or of short ones.
- **Baumler et al. (2026), [Can You Make It Sound Like You?](https://arxiv.org/html/2604.24444).**
  People editing model drafts ended with five times as many contractions. They rated edited drafts
  as representative of their style as text they wrote alone, though those drafts measured closer to
  the model. Perceived and measured similarity correlated at only r = 0.24. So people are lenient
  judges of their own voice. The writing was personal and never sent.
- **Nguyen et al. (2026), [Moral Mazes in the Era of LLMs](https://arxiv.org/html/2603.20231v2).**
  In role-played HR email, models clustered at high formality and high empathy. That task asked
  for warmth, and an LLM judged it. Tact is a separate measure, and the "models write longer"
  claim comes with no lengths reported.

**Supported.** Samples beat nothing. Formality is the best-supported model default to override.
Quoting samples exactly matters, because unconscious habits carry signal: in Baumler, correcting one
writer's comma "typos" cut measured self-similarity.

**Not supported.** Warmth as the largest gap from model defaults, length as a measured gap, or
any claim that picks capture how someone writes.

**Not tested by anyone.**

- Real email sent to a real reader.
- Rules against samples for one person's voice.
- One short sample.
- Whether people can pick out their own voice blind.
- Human judges of voice. Style was always scored by models.

The models tested date from 2024 to early 2026.

## What this means for the quiz

- Samples carry what people cannot report, so the paste comes first.
- Picks earn their place by overriding AI defaults. Whether they add anything on top of a
  sample is an open question.
- Satisfaction during setup is weak evidence that the voice matches.
- Treat self-judgment as secondary in any evaluation. Prefer checks on the text itself.

## Lessons from GBrain's public record

GBrain is an open-source memory system for agents with an unusually complete record of its
experiments. These lessons bear on Milton. None was measured on Milton.

- **Plain facts beat machinery.** Its largest gain was two prompt lines giving today's date and
  each page's date: 74.2% to 88.2% on a sealed test, with no model call. Time filtering, tested
  alongside, had no wins and was removed.
- **Cutting what the model reads lost or tied.** Excerpts, autocut, summaries, and a shorter tool
  list all failed to beat the full text. Milton differs in one way: a large sample store cannot be
  sent whole, so it must narrow somewhere.
- **Development wins often failed on fresh data.** Bars were set in advance, retests used fresh
  data, and results were kept per model.
- **Where an instruction sits may matter more than what it says.** A code comment claims 1 of 100
  from server instructions against 92 of 100 from the agent's own instruction file. Those numbers
  were never published.
- **A preferences page loaded into every session failed its gate:** +4.6 on Sonnet and -2.4 on GPT,
  both within noise, with GPT's instruction following down from 91.1% to 85.7%. So check delivery
  per model family.
- **Check the instrument before reading the result.** One conversation moved about 14 points
  between identical runs, and harness bugs invalidated whole results.

## What has not been observed

- **The quiz's writing value.** A planned test compares drafts from an empty account, a sample
  alone, and a sample plus picks, on the same five briefs, scored rule by rule. It has not run. One
  known confound: while an account has no rules, reads carry the setup script, so empty and
  sample-only drafts see every quiz snippet and sample-plus-picks drafts do not.
- **The newcomer path, end to end, on an isolated profile.** A planned run was deferred before its
  first sign-in.
- **Unprompted reads in a real client.** Only a stub has been tested (see
  [sample-ranking-2026.md](sample-ranking-2026.md)).
- **Clients other than Claude Code.** No draft or read behavior has been measured on ChatGPT.

## Running an isolated client

Anyone testing Milton locally should keep these in mind:

- Set a separate `CLAUDE_CONFIG_DIR` and always pass `--strict-mcp-config`. Otherwise the profile
  loads the account's claude.ai connectors, including a real Milton connection.
- Sign in from a private window. A reused browser session can land on the wrong account.
- Read before any save, and confirm the version is the test account's.
- `codex mcp add` stores credentials by server name and URL, not by `CODEX_HOME`, so an
  "isolated" Codex setup can overwrite the real one.
