import { StoreError } from "./store/errors";

type Source = { id: string; description: string; text: string };
type Edit = { before: string; after: string };

/** The one card whose text contains `before` exactly once, across all cards;
 * null when it occurs more than once, undefined when it occurs nowhere. */
function findAnchor(memos: Source[], before: string) {
  let match: { id: string; start: number } | undefined;
  for (const memo of memos) {
    const start = memo.text.indexOf(before);
    if (start < 0) continue;
    if (match || memo.text.indexOf(before, start + 1) >= 0) return null;
    match = { id: memo.id, start };
  }
  return match;
}
/** Assembly prints every rule as "- " plus its body, so a quote copied with
 * that bullet which matches no rule verbatim is matched without it, under the
 * same once-within-one-rule condition. `bulleted` marks that fallback. */
function resolveAnchor(memos: Source[], before: string) {
  const verbatim = findAnchor(memos, before);
  if (verbatim) return { ...verbatim, length: before.length, bulleted: false };
  if (verbatim === null || !before.startsWith("- ") || before === "- ")
    return undefined;
  const stripped = before.slice(2);
  const match = findAnchor(memos, stripped);
  return match
    ? { ...match, length: stripped.length, bulleted: true }
    : undefined;
}
/** Resolve caller-authored moves against the original snapshot. Each quote
 * identifies one card, and a card moves at most once per save. */
export function exactMoves<R extends string>(
  memos: Source[],
  moves: { before: string; report: R }[],
) {
  const resolved = new Map<string, R>();
  for (const move of moves) {
    const id = resolveAnchor(memos, move.before)?.id;
    if (!id || resolved.has(id))
      throw new StoreError(
        "move_conflict",
        "Each move must quote text that occurs exactly once in one current rule, and each rule can move once per save. Read the cover sheet and reports again. Nothing was changed.",
        409,
      );
    resolved.set(id, move.report);
  }
  return [...resolved].map(([id, report]) => ({ id, report }));
}

// The caller authors the replacements. Resolve all anchors against the same
// original snapshot; never search text produced by an earlier edit.
export function exactEditsProposal(memos: Source[], edits: Edit[]) {
  const conflict = () =>
    new StoreError(
      "edit_conflict",
      "Each exact edit must match one unique, nonoverlapping span in a current instruction card. Read TPS again and include enough surrounding text to identify it. Nothing was changed.",
      409,
    );
  const changes = new Map<
    string,
    { start: number; end: number; after: string }[]
  >();
  for (const edit of edits) {
    const match = resolveAnchor(memos, edit.before);
    if (!match) throw conflict();
    const spans = changes.get(match.id) ?? [];
    // A bullet copied into after is dropped once, so it never doubles.
    spans.push({
      start: match.start,
      end: match.start + match.length,
      after:
        match.bulleted && edit.after.startsWith("- ")
          ? edit.after.slice(2)
          : edit.after,
    });
    changes.set(match.id, spans);
  }
  const updates: Source[] = [],
    retire: string[] = [];
  for (const memo of memos) {
    const spans = changes.get(memo.id);
    if (!spans) continue;
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++)
      if (spans[i]!.start < spans[i - 1]!.end) throw conflict();
    let text = memo.text;
    for (const span of spans.toReversed())
      text = text.slice(0, span.start) + span.after + text.slice(span.end);
    if (text.trim()) updates.push({ ...memo, text });
    else retire.push(memo.id);
  }
  return { updates, retire };
}
