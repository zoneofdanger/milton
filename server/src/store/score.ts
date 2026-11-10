// Model-free numbers a memo gets at save, and the scoreboard the TPS page shows.

/** Words and single punctuation marks, as the change score counts them. */
export function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu) ?? [];
}

/** Above this many cells the edit distance is not computed: about 20 million
 * steps, tens of milliseconds, so a save of two long documents stays quick. */
export const MAX_SCORED_CELLS = 20_000_000;

/** Normalized token Levenshtein from `from` to `to`: the edit distance over
 * the longer token count (PRELUDE's normalized cost), from 0 (identical) to 1.
 * Undefined when the texts differ in too many tokens to score quickly. */
export function change(from: string, to: string): number | undefined {
  const a = tokens(from);
  const b = tokens(to);
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 0;
  // A shared prefix and suffix cost nothing, so only the middle is compared.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1])
    (endA--, endB--);
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return Math.max(n, m) / longer;
  if (n * m > MAX_SCORED_CELLS) return undefined;
  let previous = new Uint32Array(m + 1);
  let current = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) previous[j] = j;
  for (let i = 1; i <= n; i++) {
    current[0] = i;
    const token = a[start + i - 1];
    for (let j = 1; j <= m; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (token === b[start + j - 1] ? 0 : 1),
      );
    [previous, current] = [current, previous];
  }
  return previous[m]! / longer;
}

export type Tier = "own" | "steered" | "untouched";
export type FirstDraftState = "kept" | "missing" | "none";

/** Which examples a final can be, from the memo's source alone
 * (docs/memos.md): writing the person gave and edit-mode finals are their own
 * words; a drafted final is steered when it differs from its first draft and
 * untouched when it equals it. Without the first draft, a drafted final with
 * at least one redraft is steered, and one with none is untouched. */
export function tier(memo: {
  state: FirstDraftState;
  mode?: "draft" | "edit";
  firstDraft?: string;
  final: string;
  rounds?: number;
}): Tier {
  if (memo.state === "none" || memo.mode === "edit") return "own";
  if (memo.state === "kept")
    return memo.firstDraft === memo.final ? "untouched" : "steered";
  return (memo.rounds ?? 0) > 0 ? "steered" : "untouched";
}

/** A tweak's identity: case, spacing and trailing punctuation folded, so an
 * exact repeat in any of those reuses the tweak. */
export const normalizeTweak = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?;:,…]+$/u, "");

/** One scored memo, oldest first, as the scoreboard reads it. */
export type ScoredMemo = {
  mode: "draft" | "edit";
  rounds: number;
  change: number;
  untouched: boolean;
  at: Date;
};
export type ScoreLine = {
  rounds: number;
  change: number;
  accepted: number;
};
export type Scoreboard = {
  mode: "draft" | "edit";
  count: number;
  /** Absent below SCOREBOARD_MIN memos, so the two groups never overlap. */
  latest?: ScoreLine;
  earlier?: ScoreLine;
  /** first-five: the first 5 against the latest 5; days: the last 30 days
   * against the 30 before, once there are SCOREBOARD_DAYS_AT memos. */
  basis?: "first-five" | "days";
};
export const SCOREBOARD_MIN = 10;
export const SCOREBOARD_DAYS_AT = 60;
const DAY = 86_400_000;

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const line = (memos: ScoredMemo[]): ScoreLine | undefined =>
  memos.length
    ? {
        rounds: median(memos.map((m) => m.rounds)),
        change: median(memos.map((m) => m.change)),
        accepted: memos.filter((m) => m.untouched).length / memos.length,
      }
    : undefined;

/** Draft and edit memos scored apart, since edit memos start from the
 * person's text and change little. Only memos with a kept first draft and a
 * score count. */
export function scoreboard(memos: ScoredMemo[], now = new Date()) {
  return (["draft", "edit"] as const).map((mode): Scoreboard => {
    const mine = memos
      .filter((m) => m.mode === mode)
      .toSorted((a, b) => a.at.getTime() - b.at.getTime());
    if (mine.length < SCOREBOARD_MIN) return { mode, count: mine.length };
    if (mine.length >= SCOREBOARD_DAYS_AT) {
      const since = (days: number) => now.getTime() - days * DAY;
      return {
        mode,
        count: mine.length,
        basis: "days",
        latest: line(mine.filter((m) => m.at.getTime() >= since(30))),
        earlier: line(
          mine.filter(
            (m) => m.at.getTime() >= since(60) && m.at.getTime() < since(30),
          ),
        ),
      };
    }
    return {
      mode,
      count: mine.length,
      basis: "first-five",
      latest: line(mine.slice(-5)),
      earlier: line(mine.slice(0, 5)),
    };
  });
}
