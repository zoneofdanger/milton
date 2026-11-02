# Derived systems: what was built, measured and removed

Milton briefly ran four systems derived from its canonical instruction cards. None
changed canonical text; all defaulted off. Migration 0018 removes their schema;
commit `ff8659c` is the last one that holds their code.

## What was built

- **Embeddings (0009).** One vector per exact card version, used to pick candidate
  pairs.
- **Advisory graph (0009, 0011).** A model reviewed four candidate pairs per batch,
  with every card as context, recording overlap, conflict, exception or unknown links
  with quotes.
- **Task-aware retrieval (0013).** A second embedding set. A read with a short task
  returned up to eight related complete cards beside the full report.
- **Observation-only gardening (0007).** Each save queued a delayed audit by a
  stronger model, which recorded a verdict and suggested wording, never applied.

## What was measured

Local experiments on fictional data:

- **Retrieval, 64 cards and 12 queries.** Vector search found every labeled
  candidate in 11 of 12 queries (94.4% mean recall); with a hand-labeled correct graph,
  12 of 12, at 22.9% precision. Three wrong links changed 11 of 12 candidate lists.
- **Similarity is not meaning.** With a small local model, a rule and its
  contradiction scored 0.946 cosine; a 0.7 threshold called 7 of 18 non-duplicates
  (six conflicts) duplicates.
- **Long history, 96,000 simulated interactions.** Vector recall was 99.1% (quiet
  accounts) and 90.2% (steady); a correct graph completed 6 more of 112 queries. A
  50-interaction index lag cut graph recall to 80.4% and 83.9%. All 960 unsupported
  queries still returned candidates.
- **Gardening pilot, 20 known development cases.** The reviewer flagged all 7 bad
  edits and none of 13 good ones, for about $0.39. A later test found no gain from
  graph hints (four of four correct either way).
- **Delivery.** Giving a model the exact instruction met the rubric in 8 of 8 matched
  probes, against 5 of 8 without it, with no retrieval involved.

In production:

- The graph selected 16 pairs: 12 reviewed, 4 failed and never retried. One failure
  reproduced as the 8,192-token thinking and output budget running out. A review of the
  five live links found two explanations overstated and three links of low use.
- Task retrieval served one enrolled account. Release verification requested a guide
  once; the installed client hooks never sent a task, and after the reports release no
  public tool could.
- The gardening queue recorded no jobs before it was paused.

## Limitations

- Fixtures were fictional, templated and author-labeled. Graph gains depended on
  correct links that no model was shown to produce.
- The gardening sets were small and known in advance: ceiling results, not accuracy.
  Exact quotes prove attribution, not meaning.
- Each graph review or audit reserved up to $0.461824 and each embedding $0.006144,
  under separate daily budgets, plus a vector extension, a prediction IAM grant,
  three job classes and six tables.

## Why it was removed

- **Product direction.** Milton now serves a cover sheet plus five reports with
  samples, each read in full on demand, so retrieval has nothing to narrow.
- **No reader.** No public tool served task guidance after the reports release,
  gardening findings were visible only to an operator script, and graph links fed only
  those two.
- **Cost.** Paid background work, budgets, IAM and schema for unread outputs. Index
  lag meant every reader kept the full source as a fallback anyway.

## What would justify rebuilding

- **Retrieval:** reports measured approaching an assistant's context limit, plus a
  held-out test where a retrieved subset matches or beats the full report on drafting
  behavior.
- **Graph or conflict detection:** real saves that repeatedly duplicate or contradict
  existing rules, plus an independently adjudicated, held-out set on which
  model-proposed links are accurate.
- **Gardening:** incorrect saves in real use (lost scope or conditions) frequent
  enough to pay for a second model, and a surface where someone acts on findings.
- **Embeddings:** only as candidate generation for one of the above, never as
  authority to merge.

## Sources

Internal reports under `.agents/tmp/` (not in the repository):
`brainstorm-combined-postgres-20261101/report.md`,
`brainstorm-long-history-20261101/report.md`, `gardening-pilot/report.md`,
`graph-reliability/report.md`, `vector-graph-release-20261101/release-report.md`,
`controlled-representation-20261101/report.md`.

Removed code and documentation, at `ff8659c`: `server/src/{derivations,retrieval,gardener}.ts`,
`server/src/store/{derivations,gardening,task-retrieval}.ts`, and the derived sections
of `server/README.md`, `server/deploy/README.md` and `SPEC.md`.
