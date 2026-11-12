// What changed between a memo's first draft and its final, found by code at
// save (docs/memos.md, "Changes"): a token diff into changed spots, each
// stored as one unlabelled row. Model-free and deterministic; nothing here
// touches the database.
import { MAX_SCORED_CELLS } from "./score";

/** Words and single punctuation marks, as the change score counts them, with
 * each token's UTF-16 offsets. */
const TOKEN = /[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu;
type Token = { t: string; s: number; e: number };
const tokenize = (text: string): Token[] =>
  [...text.matchAll(TOKEN)].map((m) => ({
    t: m[0],
    s: m.index,
    e: m.index + m[0].length,
  }));

/** Edits separated by at most this many unchanged tokens on one line are one
 * spot, so "Hi Dana," → "Dana —" is one change (E0: half the spots of no
 * merging; three or more starts joining unrelated edits). */
export const MERGE_GAP = 2;
/** More changed spots than this and the list is not kept (`too_large`); E0's
 * emails reached 15, so this bounds only long documents. */
export const MAX_SPOTS = 100;
/** The diff gives up past this many changed tokens, which bounds its working
 * memory (the edit trace) to about 16 MB; such a memo is `too_large`. */
export const MAX_CHANGED_TOKENS = 2000;
/** A stored side is cut to this many characters, with `truncated` set, and
 * the memo page marks the cut. A long spot is cut rather than making its memo
 * `too_large`, which stays only for changeList's own bounds: whole-spot rows
 * would have pushed 8 of 37 replayed memos to `too_large`, and with no labels
 * or served examples a marked cut hides nothing (docs/memos.md). */
export const MAX_SIDE = 300;

/** One changed spot: offsets into the first draft and the final (an empty
 * side is the point where the other side's words were added or cut). */
export type Spot = {
  draftStart: number;
  draftEnd: number;
  finalStart: number;
  finalEnd: number;
  /** The sides differ only in Markdown marks and whitespace. */
  format: boolean;
};
export type ChangeList =
  { state: "itemized"; spots: Spot[] } | { state: "too_large" };

type Op = 0 | 1 | 2; // equal, delete (first draft only), insert (final only)

/** Myers' O(ND) diff over token strings, keeping only the slice of the
 * frontier each step reads back; undefined past maxD edits. */
function myers(a: string[], b: string[], maxD: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > maxD) return undefined;
    // The frontier before step d, for k in -d..d, at index k + d.
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) (x++, y++);
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d]!;
    const at = (k: number) => before[k + d]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) (ops.push(0), x--, y--);
    if (x === prevX) (ops.push(2), y--);
    else (ops.push(1), x--);
  }
  while (x > 0 && y > 0) (ops.push(0), x--, y--);
  return ops.reverse();
}

/** Markdown marks and whitespace: a spot whose sides differ only in these is
 * about format ("Thursday" → "**Thursday**"). */
const MARKS = /[\s*_#`>~|]/g;
const unmarked = (text: string) => text.replace(MARKS, "");

/** The changed spots from a first draft to its final: tokens compared by
 * exact text (case counts), a shared prefix and suffix skipped, edits within
 * MERGE_GAP unchanged tokens on one line merged. `too_large` past the change
 * score's cell bound, MAX_CHANGED_TOKENS or MAX_SPOTS. */
export function changeList(first: string, final: string): ChangeList {
  const A = tokenize(first);
  const B = tokenize(final);
  let start = 0;
  while (start < A.length && start < B.length && A[start]!.t === B[start]!.t)
    start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1]!.t === B[endB - 1]!.t)
    (endA--, endB--);
  if ((endA - start) * (endB - start) > MAX_SCORED_CELLS)
    return { state: "too_large" };
  const ops = myers(
    A.slice(start, endA).map((x) => x.t),
    B.slice(start, endB).map((x) => x.t),
    MAX_CHANGED_TOKENS,
  );
  if (!ops) return { state: "too_large" };
  // Hunks in token indices, half open.
  type Hunk = { a0: number; a1: number; b0: number; b1: number };
  const hunks: Hunk[] = [];
  let i = start;
  let j = start;
  let open: Hunk | undefined;
  for (const op of ops) {
    if (op === 0) {
      if (open) (hunks.push(open), (open = undefined));
      i++;
      j++;
      continue;
    }
    open ??= { a0: i, a1: i, b0: j, b1: j };
    if (op === 1) open.a1 = ++i;
    else open.b1 = ++j;
  }
  if (open) hunks.push(open);
  const merged: Hunk[] = [];
  for (const h of hunks) {
    const p = merged.at(-1);
    if (p && h.a0 - p.a1 <= MERGE_GAP) {
      const gapA = first.slice(
        A[p.a1 - 1]?.e ?? A[p.a1]?.s ?? 0,
        A[h.a0]?.s ?? first.length,
      );
      const gapB = final.slice(
        B[p.b1 - 1]?.e ?? B[p.b1]?.s ?? 0,
        B[h.b0]?.s ?? final.length,
      );
      if (!gapA.includes("\n") && !gapB.includes("\n")) {
        p.a1 = h.a1;
        p.b1 = h.b1;
        continue;
      }
    }
    merged.push({ ...h });
  }
  if (merged.length > MAX_SPOTS) return { state: "too_large" };
  // An empty side sits right after the token before it.
  const at = (T: Token[], s: number, e: number): [number, number] => {
    if (s < e) return [T[s]!.s, T[e - 1]!.e];
    const p = s > 0 ? T[s - 1]!.e : (T[0]?.s ?? 0);
    return [p, p];
  };
  return {
    state: "itemized",
    spots: merged.map((h) => {
      const [draftStart, draftEnd] = at(A, h.a0, h.a1);
      const [finalStart, finalEnd] = at(B, h.b0, h.b1);
      return {
        draftStart,
        draftEnd,
        finalStart,
        finalEnd,
        format:
          unmarked(first.slice(draftStart, draftEnd)) ===
          unmarked(final.slice(finalStart, finalEnd)),
      };
    }),
  };
}

// ---------------------------------------------------------------- rows

/** One memo_changes row: a spot's offsets and its two sides as code cut them
 * from the stored texts. `about` is "format" for a Markdown-only spot, code's
 * own marker, and NULL otherwise; the row has no other label. */
export type ChangeRow = {
  n: number;
  draftStart: number;
  draftEnd: number;
  finalStart: number;
  finalEnd: number;
  before: string;
  after: string;
  truncated: boolean;
  about: "format" | null;
};

const capped = (text: string) => {
  const chars = Array.from(text);
  return chars.length > MAX_SIDE
    ? { text: chars.slice(0, MAX_SIDE).join(""), cut: true }
    : { text, cut: false };
};

/** The rows a save stores: one per spot, in text order; none when the list
 * is too_large. */
export function changeRows(
  first: string,
  final: string,
  list: ChangeList,
): ChangeRow[] {
  if (list.state === "too_large") return [];
  return list.spots.map((spot, n) => {
    const before = capped(first.slice(spot.draftStart, spot.draftEnd));
    const after = capped(final.slice(spot.finalStart, spot.finalEnd));
    return {
      n,
      draftStart: spot.draftStart,
      draftEnd: spot.draftEnd,
      finalStart: spot.finalStart,
      finalEnd: spot.finalEnd,
      before: before.text,
      after: after.text,
      truncated: before.cut || after.cut,
      about: spot.format ? "format" : null,
    };
  });
}
