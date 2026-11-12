// The quote rule for itemized memos (docs/memos.md, "Locating a quote"),
// checked against a deliberately simple, slow reference written straight from
// the rule: every character marked with its edit, occurrences found by brute
// force, every pair of occurrences judged, then the tiers. Only changeList's
// diff (its edits) is shared with the matcher; none of locate's logic is.
import { expect, test } from "bun:test";
import {
  changeList,
  fold,
  locate,
  MAX_OCCURRENCES,
  type Located,
  type Range,
} from "../src/store/changes";

const TOKEN = /[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu;
const tokens = (text: string) =>
  [...text.matchAll(TOKEN)].map((m) => ({
    s: m.index,
    e: m.index + m[0].length,
  }));

type Change = { before: string; after: string };
function reference(first: string, final: string, change: Change): Located {
  const list = changeList(first, final);
  if (list.state !== "itemized") throw new Error("reference is itemized only");
  const all = list.spots.flatMap((spot, n) =>
    spot.edits.map((e) => ({ ...e, n, format: spot.format })),
  );
  const sides = [
    { name: "before" as const, text: first, quote: change.before },
    { name: "after" as const, text: final, quote: change.after },
  ].map((side) => {
    const before = side.name === "before";
    const T = tokens(side.text);
    // Every character of the text, marked with the edit whose changed token
    // it is (-1: kept or space); format edits marked apart.
    const marks = new Array<number>(side.text.length).fill(-1);
    const changed = new Set<number>();
    const gaps = new Map<number, Range>();
    all.forEach((e, id) => {
      const has = before ? e.cut : e.added;
      const range = before ? e.draft : e.final;
      if (!has) {
        // Sanity: a gap runs from a token's end (or the start) to the next
        // token's start (or the end), with no token inside.
        const [g0, g1] = range;
        expect(g0 === 0 || T.some((t) => t.e === g0)).toBe(true);
        expect(g1 === side.text.length || T.some((t) => t.s === g1)).toBe(true);
        expect(T.some((t) => t.s >= g0 && t.e <= g1 && t.s < t.e)).toBe(false);
        if (!e.format) gaps.set(id, range);
        return;
      }
      const inside = T.filter((t) => t.s >= range[0] && t.e <= range[1]);
      expect(inside.length).toBeGreaterThan(0);
      for (const t of inside) {
        changed.add(T.indexOf(t));
        if (!e.format) for (let c = t.s; c < t.e; c++) marks[c] = id;
      }
    });
    const kept = T.filter((_, i) => !changed.has(i)).map((t) =>
      side.text.slice(t.s, t.e),
    );
    // Occurrences by brute force over the folded text.
    const F = fold(side.text);
    const q = fold(side.quote.trim()).f.trim();
    const occs: { range: Range; held: Set<number>; touched: Set<number> }[] =
      [];
    let any = false;
    if (side.quote.trim() && q)
      for (let k = 0; k + q.length <= F.f.length; k++) {
        if (F.f.slice(k, k + q.length) !== q) continue;
        any = true;
        const range: Range = [F.starts[k]!, F.ends[k + q.length - 1]!];
        const held = new Set<number>();
        for (let c = range[0]; c < range[1]; c++)
          if (marks[c]! >= 0) held.add(marks[c]!);
        const touched = new Set<number>();
        for (const [id, [g0, g1]] of gaps)
          for (let p = g0; p <= g1; p++)
            if (range[0] <= p && p <= range[1]) touched.add(id);
        if (held.size || touched.size) occs.push({ range, held, touched });
      }
    return { ...side, kept, any, occs, empty: !side.quote.trim() };
  });
  const [B, A] = sides as [(typeof sides)[0], (typeof sides)[0]];
  // Sanity: the kept tokens read the same on both sides.
  expect(B.kept).toEqual(A.kept);
  if ((!B.empty && !B.any) || (!A.empty && !A.any))
    return { ok: false, why: "not_in_text" };
  if (B.occs.length > MAX_OCCURRENCES || A.occs.length > MAX_OCCURRENCES)
    return { ok: false, why: "ambiguous" };
  const cut = (id: number) => all[id]!.cut;
  const added = (id: number) => all[id]!.added;
  const has = (set: Set<number>, f: (id: number) => boolean) =>
    [...set].some(f);
  const pairs = [];
  for (const b of B.empty ? [undefined] : B.occs)
    for (const a of A.empty ? [undefined] : A.occs) {
      const hb = b?.held ?? new Set<number>();
      const ha = a?.held ?? new Set<number>();
      const validB =
        !b || hb.size > 0 || has(b.touched, (id) => !cut(id) && ha.has(id));
      const validA =
        !a || ha.size > 0 || has(a.touched, (id) => !added(id) && hb.has(id));
      const union = new Set([...hb, ...ha]);
      if (!validB || !validA || !union.size) continue;
      if (
        a &&
        b &&
        first.slice(...b.range) === final.slice(...a.range) &&
        !(hb.size && ha.size)
      )
        continue;
      const spotsB = new Set([...hb].map((id) => all[id]!.n));
      const spotsA = new Set([...ha].map((id) => all[id]!.n));
      const tier =
        has(hb, (id) => ha.has(id)) ||
        (b && !hb.size && has(b.touched, (id) => ha.has(id))) ||
        (a && !ha.size && has(a.touched, (id) => hb.has(id)))
          ? 1
          : has(spotsB, (n) => spotsA.has(n))
            ? 2
            : 3;
      const spots = [...new Set([...union].map((id) => all[id]!.n))].sort(
        (x, y) => x - y,
      );
      pairs.push({ b, a, tier, spots });
    }
  if (!pairs.length) return { ok: false, why: "not_at_change" };
  const tier = Math.min(...pairs.map((p) => p.tier));
  const best = pairs
    .filter((p) => p.tier === tier)
    .sort(
      (x, y) =>
        (x.b?.range[0] ?? -1) - (y.b?.range[0] ?? -1) ||
        (x.a?.range[0] ?? -1) - (y.a?.range[0] ?? -1),
    );
  if (new Set(best.map((p) => p.spots.join(","))).size > 1)
    return { ok: false, why: "ambiguous" };
  const [p] = best;
  return {
    ok: true,
    spots: p!.spots,
    ...(p!.b ? { before: p!.b.range } : {}),
    ...(p!.a ? { after: p!.a.range } : {}),
  };
}

const matcher = (first: string, final: string, change: Change) =>
  locate(
    changeList(first, final),
    { first: fold(first), final: fold(final) },
    change,
  );

// A fixed-seed generator (mulberry32), so a failure reproduces.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("the matcher agrees with the reference on every quote pair of small random memos", () => {
  const rand = random(109);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const words = ["a", "b", "c", "well", "-", "—", ".", "*"] as const;
  const joins = [" ", " ", " ", "\n", ""] as const;
  const join = (ws: string[]) =>
    ws.map((w, i) => (i ? pick(joins) : "") + w).join("");
  let cases = 0;
  let pairs = 0;
  let accepted = 0;
  for (let c = 0; c < 1500; c++) {
    const draft = Array.from({ length: Math.floor(rand() * 8) }, () =>
      pick(words),
    );
    const edited = [...draft];
    for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) {
      const at = Math.floor(rand() * (edited.length + 1));
      const op = rand();
      if (op < 0.33 && at < edited.length) edited.splice(at, 1);
      else if (op < 0.66 || at >= edited.length)
        edited.splice(at, 0, pick(words));
      else edited[at] = pick(words);
    }
    const first = join(draft);
    const final = join(edited.slice(0, 7));
    const spans = (text: string) => {
      const T = tokens(text);
      const out = new Set([""]);
      for (let i = 0; i < T.length; i++)
        for (let j = i; j < T.length; j++)
          out.add(text.slice(T[i]!.s, T[j]!.e));
      return [...out];
    };
    cases++;
    for (const before of spans(first))
      for (const after of spans(final)) {
        if (!before && !after) continue;
        pairs++;
        const want = reference(first, final, { before, after });
        const got = matcher(first, final, { before, after });
        if (want.ok) accepted++;
        if (JSON.stringify(got) !== JSON.stringify(want))
          expect({ first, final, before, after, got }).toEqual({
            first,
            final,
            before,
            after,
            got: want,
          });
      }
  }
  // Enough of both outcomes to mean something.
  expect(cases).toBe(1500);
  expect(pairs).toBeGreaterThan(100_000);
  expect(accepted).toBeGreaterThan(pairs / 20);
  console.log(
    `quote rule: ${cases} memos, ${pairs} pairs, ${accepted} accepted`,
  );
  // About 3 s locally and 9 s on CI's runner: past bun's 5 s default.
}, 60_000);

// The rule's table and the reviewers' cases, by name. Each expects the stored
// text of both sides when accepted (an empty side stores nothing here), and
// the reference agrees.
type Want =
  | { before?: string; after?: string; spots?: number }
  | Extract<Located, { ok: false }>["why"];
const cases: [string, string, string, string, string, Want][] = [
  // Replace.
  [
    "replace, exactly",
    "red car",
    "blue car",
    "red",
    "blue",
    { before: "red", after: "blue" },
  ],
  [
    "replace, with context",
    "red car",
    "blue car",
    "red car",
    "blue car",
    { before: "red car", after: "blue car" },
  ],
  [
    "replace, only unchanged",
    "red car",
    "blue car",
    "car",
    "car",
    "not_at_change",
  ],
  [
    "replace, one side empty",
    "red car",
    "blue car",
    "",
    "blue",
    { after: "blue" },
  ],
  // Pure deletion.
  [
    "deletion, exactly",
    "red small car",
    "red car",
    "small",
    "",
    { before: "small" },
  ],
  [
    "deletion, context on the empty side",
    "red small car",
    "red car",
    "red small",
    "red",
    { before: "red small", after: "red" },
  ],
  [
    "R2a: deletion, only unchanged with one side empty",
    "red small car",
    "red car",
    "",
    "red",
    "not_at_change",
  ],
  [
    "deletion, only unchanged on both sides",
    "red small car",
    "red car",
    "red",
    "red",
    "not_at_change",
  ],
  // Pure insertion, at either edge of the quote.
  [
    "insertion, exactly",
    "I like red cars",
    "I like new red cars",
    "",
    "new",
    { after: "new" },
  ],
  [
    "insertion at the quote's left edge",
    "I like red cars",
    "I like new red cars",
    "red",
    "new red",
    { before: "red", after: "new red" },
  ],
  [
    "insertion at the quote's right edge",
    "I like red cars",
    "I like new red cars",
    "like",
    "like new",
    { before: "like", after: "like new" },
  ],
  [
    "insertion, only unchanged",
    "I like red cars",
    "I like new red cars",
    "red",
    "red",
    "not_at_change",
  ],
  // A move: the diff cuts the sentence at one spot and adds it at another.
  [
    "move, exactly: identical text, both spots",
    "Alpha beta gamma. Delta epsilon.",
    "Delta epsilon. Alpha beta gamma.",
    "Delta epsilon.",
    "Delta epsilon.",
    { before: "Delta epsilon.", after: "Delta epsilon.", spots: 2 },
  ],
  [
    "move, with context",
    "Alpha beta gamma. Delta epsilon.",
    "Delta epsilon. Alpha beta gamma.",
    "gamma. Delta epsilon.",
    "Delta epsilon. Alpha",
    {
      before: "gamma. Delta epsilon.",
      after: "Delta epsilon. Alpha",
      spots: 2,
    },
  ],
  [
    "move, a kept-only side as context where the addition sits",
    "Alpha beta gamma. Delta epsilon.",
    "Delta epsilon. Alpha beta gamma.",
    "Alpha beta",
    "Delta epsilon.",
    { before: "Alpha beta", after: "Delta epsilon.", spots: 1 },
  ],
  [
    "move, one side only kept words, away from any edit",
    "Alpha beta gamma. Delta epsilon.",
    "Delta epsilon. Alpha beta gamma.",
    "beta gamma",
    "Delta epsilon.",
    "not_at_change",
  ],
  [
    "move, as a cut",
    "Alpha beta gamma. Delta epsilon.",
    "Delta epsilon. Alpha beta gamma.",
    "Delta epsilon.",
    "",
    { before: "Delta epsilon.", spots: 1 },
  ],
  [
    "move, as an addition",
    "Alpha beta gamma. Delta epsilon.",
    "Delta epsilon. Alpha beta gamma.",
    "",
    "Delta epsilon.",
    { after: "Delta epsilon.", spots: 1 },
  ],
  // A merged spot with an unchanged word inside.
  [
    "merged, exactly",
    "red small car",
    "blue small van",
    "red",
    "blue",
    { before: "red", after: "blue" },
  ],
  [
    "merged, with context",
    "red small car",
    "blue small van",
    "red small car",
    "blue small van",
    { before: "red small car", after: "blue small van" },
  ],
  [
    "R1a: merged, only the unchanged word",
    "red small car",
    "blue small van",
    "small",
    "small",
    "not_at_change",
  ],
  [
    "merged, unchanged before against a real edit after",
    "red small car",
    "blue small van",
    "small",
    "small van",
    "not_at_change",
  ],
  [
    "merged, one side empty",
    "red small car",
    "blue small van",
    "",
    "blue",
    { after: "blue" },
  ],
  [
    "R2b: insertion inside a merged spot, with context",
    "I like red cars",
    "I like new red vans",
    "red",
    "new red",
    { before: "red", after: "new red" },
  ],
  [
    "R2c: repeats in a merged spot; the earlier occurrence would cut identical text with a context-only side",
    "well well well -",
    "well - well —",
    "well -",
    "well —",
    { before: "well -", after: "well —" },
  ],
  // Identical stored text only as an exact move.
  [
    "identical text, one side context",
    "b c",
    "b b c",
    "b",
    "b",
    "not_at_change",
  ],
  [
    "identical text avoided by context",
    "b c",
    "b b c",
    "b",
    "b b",
    { before: "b", after: "b b" },
  ],
  // Coverage: only the spots of held edits; bordering another spot is not covering it.
  [
    "coverage, a quote that only borders another spot",
    "a b c d e f g",
    "a c d e f g h",
    "b c d e f g",
    "",
    { before: "b c d e f g", spots: 1 },
  ],
  // Format only: code's rows, never a change. (The fold drops a quote's
  // leading marks, so the stored side starts at its first word.)
  [
    "format, exactly",
    "**useful** idea",
    "useful idea",
    "**useful**",
    "useful",
    "not_at_change",
  ],
  [
    "format, only unchanged",
    "**useful** idea",
    "useful idea",
    "idea",
    "idea",
    "not_at_change",
  ],
  [
    "format, one side empty",
    "**useful** idea",
    "useful idea",
    "",
    "useful",
    "not_at_change",
  ],
  [
    "format, with a real edit",
    "**useful** idea",
    "useful plan",
    "**useful** idea",
    "useful plan",
    { before: "useful** idea", after: "useful plan" },
  ],
  // Repeated occurrences: only the one at a change counts.
  [
    "repeated, one at a change",
    "Yes. Fine. Yes.",
    "Yes. Fine.",
    "Yes.",
    "",
    { before: "Yes." },
  ],
  [
    "repeated, at two changes",
    "No. This is fine. No.",
    "This is fine.",
    "No",
    "",
    "ambiguous",
  ],
];

for (const [name, first, final, before, after, want] of cases)
  test(`quote rule: ${name}`, () => {
    const got = matcher(first, final, { before, after });
    expect(got).toEqual(reference(first, final, { before, after }));
    if (typeof want === "string") {
      expect(got).toEqual({ ok: false, why: want });
      return;
    }
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect({
      before: got.before && first.slice(...got.before),
      after: got.after && final.slice(...got.after),
    }).toEqual({ before: want.before, after: want.after });
    if (want.spots) expect(got.spots).toHaveLength(want.spots);
  });

test("quote rule: R2c stores the later final occurrence", () => {
  const got = matcher("well well well -", "well - well —", {
    before: "well -",
    after: "well —",
  });
  expect(got).toMatchObject({ ok: true, after: [7, 13] });
});

test("quote rule, too large: each quote once, and R1b: whitespace-only different quotes that cut the same stored text are refused", () => {
  const long = Array.from({ length: 101 }, (_, i) => `w${i} keep keep keep`);
  const first = long.join(" ") + " Best, AI";
  const final = long.map((w) => `x${w}`).join(" ") + " Best, AI — S";
  expect(changeList(first, final).state).toBe("too_large");
  const at = (before: string, after: string) =>
    matcher(first, final, { before, after });
  expect(at("Best, AI", "Best,  AI")).toEqual({
    ok: false,
    why: "not_at_change",
  });
  expect(at("Best, AI", "AI — S")).toMatchObject({ ok: true, spots: [] });
  expect(at("", "— S")).toMatchObject({ ok: true, spots: [] });
  expect(at("keep keep", "")).toEqual({ ok: false, why: "ambiguous" });
});
