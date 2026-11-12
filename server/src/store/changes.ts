// What changed between a memo's first draft and its final, found by code at
// save (docs/memos.md, "Changes"): a token diff into changed spots, and the
// check that each change an AI names quotes the two texts where they differ.
// Model-free and deterministic; nothing here touches the database.
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
/** A stored side is cut to this many characters, with `truncated` set. */
export const MAX_SIDE = 300;
/** At most this many changes per memo, and distinct tweaks among them. */
export const MAX_CHANGES = 20;
export const MAX_MEMO_TWEAKS = 3;

/** One changed spot: offsets into the first draft and the final (an empty
 * side is the point where the other side's words were added or cut). */
export type Spot = {
  draftStart: number;
  draftEnd: number;
  finalStart: number;
  finalEnd: number;
  /** The sides differ only in Markdown marks and whitespace. */
  format: boolean;
  /** The edits the spot joins, before merging: each one's cut tokens in the
   * first draft and added tokens in the final, as offsets. A side with no
   * tokens (cut or added false) is instead the gap where the edit sits, from
   * the end of the token before to the start of the token after. */
  edits: { draft: Range; final: Range; cut: boolean; added: boolean }[];
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
  const merged: (Hunk & { raw: Hunk[] })[] = [];
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
        p.raw.push(h);
        continue;
      }
    }
    merged.push({ ...h, raw: [h] });
  }
  if (merged.length > MAX_SPOTS) return { state: "too_large" };
  // An empty side sits right after the token before it.
  const at = (T: Token[], s: number, e: number): [number, number] => {
    if (s < e) return [T[s]!.s, T[e - 1]!.e];
    const p = s > 0 ? T[s - 1]!.e : (T[0]?.s ?? 0);
    return [p, p];
  };
  // Between the token before index s and the token at it.
  const gap = (T: Token[], s: number, length: number): Range => [
    s > 0 ? T[s - 1]!.e : 0,
    s < T.length ? T[s]!.s : length,
  ];
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
        edits: h.raw.map((r) => ({
          draft: r.a0 < r.a1 ? at(A, r.a0, r.a1) : gap(A, r.a0, first.length),
          final: r.b0 < r.b1 ? at(B, r.b0, r.b1) : gap(B, r.b0, final.length),
          cut: r.a0 < r.a1,
          added: r.b0 < r.b1,
        })),
      };
    }),
  };
}

// ---------------------------------------------------------------- locating

/** A text folded for locating quotes only: NFC, curly quotes straight, every
 * whitespace run one space, the Markdown marks * _ ` dropped and em and en
 * dashes as hyphens. Each folded character keeps the offsets of the original
 * characters it came from, so a match maps back to the stored text, which is
 * kept as `text`. */
type Folded = { text: string; f: string; starts: number[]; ends: number[] };
export function fold(text: string): Folded {
  let f = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let space = false;
  // A base character with its combining marks normalizes as one piece.
  for (const run of text.matchAll(/\P{M}\p{M}*|\p{M}+/gsu)) {
    const s = run.index;
    const e = s + run[0].length;
    for (let c of run[0].normalize("NFC")) {
      if (c === "*" || c === "_" || c === "`") continue;
      if (/\s/u.test(c)) {
        if (space) continue;
        c = " ";
        space = true;
      } else space = false;
      if (c === "—" || c === "–") c = "-";
      else if (c === "‘" || c === "’") c = "'";
      else if (c === "“" || c === "”") c = '"';
      for (let k = 0; k < c.length; k++) (starts.push(s), ends.push(e));
      f += c;
    }
  }
  return { text, f, starts, ends };
}

export type Range = [number, number];
/** Each place a quote occurs in a folded text, in order, as original
 * offsets; lazy, so a caller stops scanning when it has its answer. */
function* occurrences(folded: Folded, quote: string): Generator<Range> {
  const q = fold(quote.trim()).f.trim();
  if (!q) return;
  for (let k = folded.f.indexOf(q); k >= 0; k = folded.f.indexOf(q, k + 1))
    yield [folded.starts[k]!, folded.ends[k + q.length - 1]!];
}
/** A quote with more occurrences than this that hold or touch a change is
 * ambiguous: so short or repeated a quote names no one place (a real quote of
 * a few words recurs a handful of times), and stopping here bounds the scan
 * and the pairing (one letter repeated in an 8 KB request took a second and a
 * gigabyte). */
export const MAX_OCCURRENCES = 50;

export type Located =
  | {
      ok: true;
      /** Indexes into the list's spots this change covers (none when the
       * list is too_large). */
      spots: number[];
      before?: Range;
      after?: Range;
    }
  | {
      ok: false;
      why: "not_in_text" | "not_at_change" | "ambiguous";
    };

/** Where one change's quotes are (docs/memos.md, "Locating a quote").
 * Itemized: at least one quote holds a changed token of a non-format edit on
 * its side; a sent quote holding none is context: it touches the gap where an
 * edit sits on its side, and the other quote holds that edit's tokens. Two
 * quotes cutting the same stored text must both hold changed tokens (an exact
 * move). A change covers the spots of the edits its quotes hold. Of the pairs of
 * occurrences that pass, those sharing an edit win, then those whose spots
 * meet across the sides, then the rest (a moved sentence); within the best,
 * different spots are ambiguous, and the first pair in text order is kept. Too
 * large: each quote occurs exactly once, and the two stored sides differ. */
export function locate(
  list: ChangeList,
  texts: { first: Folded; final: Folded },
  change: { before: string; after: string },
): Located {
  const sides = [
    ["before", change.before, texts.first],
    ["after", change.after, texts.final],
  ] as const;
  if (list.state === "too_large") {
    const ranges: { before?: Range; after?: Range } = {};
    for (const [name, quote, folded] of sides) {
      if (!quote.trim()) continue;
      let found: Range | undefined;
      for (const range of occurrences(folded, quote)) {
        if (found) return { ok: false, why: "ambiguous" };
        found = range;
      }
      if (!found) return { ok: false, why: "not_in_text" };
      ranges[name] = found;
    }
    // Compared as stored, so a dash or a Markdown mark is a change.
    if (
      ranges.before &&
      ranges.after &&
      texts.first.text.slice(...ranges.before) ===
        texts.final.text.slice(...ranges.after)
    )
      return { ok: false, why: "not_at_change" };
    return { ok: true, spots: [], ...ranges };
  }
  // Every non-format edit, numbered, with its spot.
  const edits = list.spots.flatMap((spot, n) =>
    spot.format ? [] : spot.edits.map((e) => ({ ...e, n })),
  );
  /** One occurrence of a quote: the edits it holds a changed token of, and
   * those whose gap on its side it touches. */
  type Occ = { range: Range; held: number[]; touched: number[] };
  const found: { before?: Occ[]; after?: Occ[] } = {};
  let ambiguous = false;
  for (const [name, quote, folded] of sides) {
    if (!quote.trim()) continue;
    const before = name === "before";
    // Edits run in text order on each side, without overlap, and occurrences
    // arrive in order, so the edits one can reach form a window that only
    // moves on.
    const side = edits.map((e, id) => ({
      id,
      range: before ? e.draft : e.final,
      tokens: before ? e.cut : e.added,
    }));
    const occs: Occ[] = [];
    let any = false;
    let lo = 0;
    for (const range of occurrences(folded, quote)) {
      any = true;
      const [s, e] = range;
      while (lo < side.length && side[lo]!.range[1] < s) lo++;
      const held: number[] = [];
      const touched: number[] = [];
      for (let k = lo; k < side.length && side[k]!.range[0] <= e; k++) {
        const {
          id,
          range: [a, b],
          tokens,
        } = side[k]!;
        if (tokens) {
          if (s < b && a < e) held.push(id);
        } else if (s <= b && a <= e) touched.push(id);
      }
      if (!held.length && !touched.length) continue;
      if (occs.length === MAX_OCCURRENCES) {
        ambiguous = true;
        break;
      }
      occs.push({ range, held, touched });
    }
    if (!any) return { ok: false, why: "not_in_text" };
    found[name] = occs;
  }
  if (ambiguous) return { ok: false, why: "ambiguous" };
  const meets = (x: number[], y: number[]) => x.some((v) => y.includes(v));
  const spotsOf = (ids: number[]) => ids.map((id) => edits[id]!.n);
  // An empty quote is one choice with nothing in it.
  const choices = (occs: Occ[] | undefined) => occs ?? [undefined];
  let best:
    | { tier: number; keys: Set<string>; spots: number[]; b?: Occ; a?: Occ }
    | undefined;
  for (const b of choices(found.before))
    for (const a of choices(found.after)) {
      const hb = b?.held ?? [];
      const ha = a?.held ?? [];
      // A side holding nothing is context for an edit the other holds.
      const okB = !b || hb.length > 0 || meets(b.touched, ha);
      const okA = !a || ha.length > 0 || meets(a.touched, hb);
      if (!okB || !okA || (!hb.length && !ha.length)) continue;
      // The same stored text on both sides is a change only as an exact move.
      if (
        a &&
        b &&
        (!hb.length || !ha.length) &&
        texts.first.text.slice(...b.range) ===
          texts.final.text.slice(...a.range)
      )
        continue;
      const tier =
        meets(hb, ha) ||
        (b !== undefined && !hb.length && meets(b.touched, ha)) ||
        (a !== undefined && !ha.length && meets(a.touched, hb))
          ? 1
          : meets(spotsOf(hb), spotsOf(ha))
            ? 2
            : 3;
      const spots = [...new Set(spotsOf([...hb, ...ha]))].sort((x, y) => x - y);
      const key = spots.join(",");
      if (best && tier > best.tier) continue;
      if (best && tier === best.tier) best.keys.add(key);
      else best = { tier, keys: new Set([key]), spots, b, a };
    }
  if (!best) return { ok: false, why: "not_at_change" };
  if (best.keys.size > 1) return { ok: false, why: "ambiguous" };
  return {
    ok: true,
    spots: best.spots,
    ...(best.b ? { before: best.b.range } : {}),
    ...(best.a ? { after: best.a.range } : {}),
  };
}

/** Why a located change was refused, as invalid_change says it. */
export const locateProblem: Record<
  Exclude<Located, { ok: true }>["why"],
  string
> = {
  not_in_text:
    "a quote is not in its text (before from the first draft, after from the final)",
  not_at_change: "the quote is in its text, but not where the two texts differ",
  ambiguous:
    "the quote matches more than one changed place; add a few words around it",
};

// ---------------------------------------------------------------- rows

export type ChangeLabel = {
  about: "voice" | "content";
  by: "person" | "asked" | "unasked";
};
/** One memo_changes row, before its tweak is resolved to an id. */
export type ChangeRow = {
  n: number;
  draftStart: number | null;
  draftEnd: number | null;
  finalStart: number | null;
  finalEnd: number | null;
  before: string;
  after: string;
  truncated: boolean;
  about: "voice" | "content" | "format" | null;
  by: ChangeLabel["by"] | null;
  /** Index into the memo's changes whose tweak this row carries. */
  tweakOf?: number;
};

const capped = (text: string) => {
  const chars = Array.from(text);
  return chars.length > MAX_SIDE
    ? { text: chars.slice(0, MAX_SIDE).join(""), cut: true }
    : { text, cut: false };
};
function cut(
  first: string,
  final: string,
  draft: Range | undefined,
  fin: Range | undefined,
) {
  const before = capped(draft ? first.slice(...draft) : "");
  const after = capped(fin ? final.slice(...fin) : "");
  return {
    draftStart: draft?.[0] ?? null,
    draftEnd: draft?.[1] ?? null,
    finalStart: fin?.[0] ?? null,
    finalEnd: fin?.[1] ?? null,
    before: before.text,
    after: after.text,
    truncated: before.cut || after.cut,
  };
}

/** The rows a save stores: one per accepted change, cut from the stored texts
 * at its quotes (an empty side sits at its first spot's point), then, when
 * itemized, one unlabelled row per spot no change covers (a Markdown-only
 * spot about format). */
export function changeRows(
  first: string,
  final: string,
  list: ChangeList,
  accepted: {
    located: Extract<Located, { ok: true }>;
    label: ChangeLabel;
    tweak: boolean;
  }[],
): ChangeRow[] {
  const rows: ChangeRow[] = accepted.map(({ located, label, tweak }, i) => {
    const spot =
      list.state === "itemized" ? list.spots[located.spots[0]!] : undefined;
    const point = (start: number | undefined): Range | undefined =>
      start === undefined ? undefined : [start, start];
    return {
      n: i,
      ...cut(
        first,
        final,
        located.before ?? point(spot?.draftStart),
        located.after ?? point(spot?.finalStart),
      ),
      about: label.about,
      by: label.by,
      ...(tweak ? { tweakOf: i } : {}),
    };
  });
  if (list.state === "itemized") {
    const covered = new Set(accepted.flatMap((a) => a.located.spots));
    list.spots.forEach((spot, n) => {
      if (covered.has(n)) return;
      rows.push({
        n: rows.length,
        ...cut(
          first,
          final,
          [spot.draftStart, spot.draftEnd],
          [spot.finalStart, spot.finalEnd],
        ),
        about: spot.format ? "format" : null,
        by: null,
      });
    });
  }
  return rows;
}

/** A memo's change counts as a saved result reports them: found, the rows
 * that are not Markdown-only; labelled, those an AI labelled. */
export const changeCounts = (
  rows: { about: string | null; by: string | null }[],
) => ({
  found: rows.filter((r) => r.about !== "format").length,
  labelled: rows.filter((r) => r.by !== null).length,
});

/** The share of a final's tokens inside changes the person typed (`by:
 * person`), from 0 to 1; undefined for a final with no tokens. Computed at
 * read, never stored. */
export function typedShare(
  final: string,
  rows: {
    by: string | null;
    finalStart: number | null;
    finalEnd: number | null;
  }[],
): number | undefined {
  const tokens = tokenize(final);
  if (!tokens.length) return undefined;
  const typed = rows.flatMap((r) =>
    r.by === "person" && r.finalStart !== null && r.finalEnd !== null
      ? [[r.finalStart, r.finalEnd] as const]
      : [],
  );
  const inside = tokens.filter((t) =>
    typed.some(([s, e]) => t.s < e && s < t.e),
  ).length;
  return inside / tokens.length;
}

/** One served example of a tweak: `added: "…"`, `cut: "…"` or
 * `"…" → "…"`, line breaks shown as " / ". */
export function exampleLine(row: { before: string; after: string }) {
  const one = (text: string) => text.replace(/\s*\n\s*/g, " / ");
  if (!row.before) return `added: "${one(row.after)}"`;
  if (!row.after) return `cut: "${one(row.before)}"`;
  return `"${one(row.before)}" → "${one(row.after)}"`;
}
