import { StoreError } from "./store/errors";
import { bullet } from "./store/reports";

type Source = { id: string; description: string; text: string };
type Edit = { before: string; after: string };

/** Resolve `before` against the rules as the person reads them: each card's
 * printed form (its bullet plus its text). The quote must occur exactly once
 * across all printed rules and within one rule; the match is then mapped back
 * to the stored bytes. A card stored without the dash prints two bytes longer,
 * so its offsets shift by two; a match starting inside that printed bullet
 * starts at stored offset 0, and `bullet` is the part of the bullet it quoted.
 * A quote that lies wholly within a bullet targets no stored text. */
function resolveAnchor(memos: Source[], before: string) {
  let found: { memo: Source; start: number } | undefined;
  for (const memo of memos) {
    const printed = bullet(memo.text);
    const start = printed.indexOf(before);
    if (start < 0) continue;
    if (found || printed.indexOf(before, start + 1) >= 0) return undefined;
    found = { memo, start };
  }
  if (!found) return undefined;
  const shift = found.memo.text.startsWith("- ") ? 0 : 2;
  const start = Math.max(0, found.start - shift);
  const end = found.start + before.length - shift;
  if (end <= start) return undefined;
  return {
    id: found.memo.id,
    start,
    end,
    bullet: shift ? "- ".slice(found.start, 2) : "",
  };
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
      "Each exact edit must match one unique, nonoverlapping span in a current instruction card. Read the cover sheet and reports again and include enough surrounding text to identify it. Nothing was changed.",
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
    // The quoted part of a printed bullet, copied into after, is dropped
    // once, so a bullet never doubles in the stored text.
    spans.push({
      start: match.start,
      end: match.end,
      after:
        match.bullet && edit.after.startsWith(match.bullet)
          ? edit.after.slice(match.bullet.length)
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
