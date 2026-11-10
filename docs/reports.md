---
name: reports
description: How get_cover_sheet and get_report read, and how a report ranks memos, picks examples and tweaks and prints its text
type: behaviour
covers:
  - server/src/store/memos.ts
  - server/src/store/compiled.ts
  - server/src/store/trials.ts
  - server/src/store/schema.ts
  - server/drizzle/0012_memos.sql
---

# Reports

What a memo, tier and tweak are is in [memos](memos.md); the tool envelopes are in
[mcp](mcp.md).

## Reads

- An AI read first passes the trial gate ([billing](billing.md)), whose statement also
  checks the account and the intent's kind, so those refuse before the gate. Reads open
  no transaction and take no lock.
- `get_cover_sheet` is then one statement: whether the account is active, the current
  cover sheet, the memo and tweak counts and the Keep memos switch. It writes nothing.
- `get_report` is then two statements outside a transaction: one loads the account and
  kind checks, the cover sheet, the kinds, every memo's ranking fields (not its words)
  and its citations, and every tweak's count; the second records the served report and
  fetches the chosen finals. A memo forgotten between them is left out.
- `get_report` writes one `served_reports` row (its `report_id` and served tweak ids);
  no other read writes.
- AI reads are blocked once an account reads as expired, but the person's own web view
  is not.
- No read calls a model.

## Ranking

A report ranks every memo by, in order:

1. the requested kind;
2. medium match;
3. word overlap of purpose and audience with the intent (stopwords dropped);
4. tier, your words before steered;
5. full-text rank (`ts_rank`, English) of the situation, any word, against the stored
   search vector of summary, purpose, audience and final;
6. newest;
7. id.

## Examples

- Examples fill by rank: never untouched finals, never finals over 128 KiB, at most 3
  steered finals (they are mostly AI text), within a 32 KiB budget (about 8k tokens).
- A block that would pass the budget is skipped for the next, and the top one is always
  served, even over the budget.
- A block's size is counted before its words are fetched, as an upper bound: its header,
  its words and a `> ` per line.
- There is no deliberate variety rule.

## Tweaks

- Tweaks come from the 10 best-ranked memos that cite any tweak, ordered by their best
  memo's rank, then citation count, then id, at most 10.
- A tweak is matched only through the memos that cite it. Ranked over all memos, the
  person's own pasted writing, which cites none, could starve tweaks.

## Text

- The text is `# Cover sheet` (when not blank), then `# Examples` (each
  `## n. kind · medium · tier label · date`, a Situation line, an Audience · Purpose line
  when known, and the final quoted with `>`), then `# Your tweaks` (one bullet per tweak
  with its memo count).
- Tier labels in report text are "your words" and "steered by you"; kind labels appear
  in example headers.
- With no example and no tweak, `is_empty` is true and the text ends with a fixed line
  telling the AI to write from the cover sheet and the request and not to claim to know
  the person's voice.
- `kinds` lists every kind on the account, ordered by label.

## Removed

Embeddings, advisory card graphs, task-aware retrieval and observation-only gardening
were built, measured and removed; their schema is absent from the baseline. What they
showed and what would justify rebuilding any of them is in
[the research note](research/derived-systems-2026.md). The default-off derived-guide
pilot was parked on 2026-11-07 and removed with memos (#76); its tables went with the
old writing.
