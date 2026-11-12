// Memos as AIs read them: the cover sheet read, and the report Milton assembles
// for one draft (docs/reports.md). Reads run no model.
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { StoreSession } from "./database";
import { accountUnavailable } from "./accounts";
import { StoreError } from "./errors";
import { utf8Bytes } from "./limits";
import { tokens, type Tier } from "./score";
import {
  changeBlocks,
  CHANGES_GUIDANCE,
  STORED_SERVABLE_SQL,
  type StoredChange,
} from "./changes";

export const MEDIA = ["email", "chat", "post", "document", "speech"] as const;
export type Medium = (typeof MEDIA)[number];

/** The cover sheet's character cap: it is served on every read and competes
 * with examples (docs/memos.md). */
export const COVER_SHEET_CHARS = 1500;
/** Examples fill by rank within this many UTF-8 bytes, about 8k tokens; the
 * top example is served even over it (docs/reports.md). */
export const EXAMPLE_BUDGET = 32768;
/** A final over this many bytes is kept but never served as an example. */
export const MAX_EXAMPLE_BYTES = 131072;
/** At most this many steered finals per report: they are mostly AI text. */
export const MAX_STEERED = 3;
/** Tweaks come from this many best-matching memos, at most this many served. */
export const TWEAK_MEMOS = 10;
export const MAX_TWEAKS = 10;

export type ReportIntent = {
  situation: string;
  medium: Medium;
  audience: string;
  purpose: string;
  kind_id?: string;
};
export type CoverSheetRead = {
  text: string;
  version: number;
  memos: number;
  tweaks: number;
  keep_memos: boolean;
  is_empty: boolean;
};
export type ServedExample = {
  memo_id: string;
  kind_id?: string;
  kind?: string;
  medium: Medium;
  tier: Exclude<Tier, "untouched">;
  date: string;
};
export type ServedTweak = { tweak_id: string; text: string; memos: number };
export type Kind = { kind_id: string; kind: string };
export type ReportRead = {
  report_id: string;
  text: string;
  is_empty: boolean;
  examples: ServedExample[];
  tweaks: ServedTweak[];
  kinds: Kind[];
};

/** The account's current cover sheet: its text and version, 0 before any. */
export const coverSheetJson = (userId: string) =>
  sql`(SELECT json_build_object('version',version,'text',text) FROM cover_sheets WHERE user_id=${userId} ORDER BY version DESC LIMIT 1)`;
export const keepMemos = (userId: string) =>
  sql`coalesce((SELECT keep_memos FROM memo_settings WHERE user_id=${userId}),true)`;

/** A tweak's score, for a query over `tweaks t` (docs/reports.md): among
 * the account's memos with a kept first draft saved since the tweak's text was
 * last set (created or reworded), s.served counts those whose report served it
 * and s.needed_again those of them that cite it too. Computed at read, never
 * stored. */
export const tweakScore = sql`LEFT JOIN LATERAL (SELECT count(*) AS served,
    count(*) FILTER (WHERE EXISTS(SELECT 1 FROM tweak_citations c
      WHERE c.user_id=m.user_id AND c.memo_id=m.id AND c.tweak_id=t.id)) AS needed_again
    FROM memos m WHERE m.user_id=t.user_id AND m.first_draft_state='kept'
      AND t.id=ANY(m.served_tweak_ids) AND m.created_at>=coalesce(t.text_changed_at,t.created_at)) s ON true`;

/** The refusal for an intent kind_id the account does not have. */
export const invalidKind = () =>
  new StoreError(
    "invalid_kind",
    "kind_id must name one of the person's kinds from get_report's kinds. Nothing was read.",
    400,
  );
/** Whether an intent's kind_id names one of the account's kinds. */
export const kindValid = (userId: string, kindId?: string) =>
  kindId
    ? sql`EXISTS(SELECT 1 FROM memo_kinds WHERE user_id=${userId} AND id=${kindId})`
    : sql`true`;

export async function readCoverSheet(
  session: StoreSession,
  userId: string,
): Promise<CoverSheetRead> {
  const row = (
    await session.query<{
      open: boolean;
      cover: { version: number; text: string } | null;
      memos: number;
      tweaks: number;
      keep_memos: boolean;
    }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
      ${coverSheetJson(userId)} AS cover,
      (SELECT count(*)::int FROM memos WHERE user_id=${userId}) AS memos,
      (SELECT count(*)::int FROM tweaks WHERE user_id=${userId}) AS tweaks,
      ${keepMemos(userId)} AS keep_memos`)
  )[0]!;
  if (!row.open) throw accountUnavailable();
  const text = row.cover?.text ?? "";
  return {
    // As served; the stored text is unchanged.
    text: joinSeparators(text),
    version: row.cover?.version ?? 0,
    memos: row.memos,
    tweaks: row.tweaks,
    keep_memos: row.keep_memos,
    is_empty: !text.trim() && row.memos === 0,
  };
}

/** One memo as the ranking sees it, without its words. */
type Candidate = {
  id: string;
  kind_id: string | null;
  medium: Medium;
  tier: Tier;
  summary: string;
  audience: string | null;
  purpose: string | null;
  at: string;
  bytes: number;
  lines: number;
  lexical: number;
  tweaks: string[];
  mode: "draft" | "edit" | null;
  first_draft_state: "kept" | "missing" | "none";
  changes_state: "itemized" | "too_large" | null;
};
const STOPWORDS = new Set(
  "a an and as at by for from i in into is it me my of on or our the their this to with your".split(
    " ",
  ),
);
const words = (text: string | null | undefined) =>
  new Set(
    tokens((text ?? "").toLowerCase()).filter(
      (w) => /[\p{L}\p{N}]/u.test(w) && !STOPWORDS.has(w),
    ),
  );
const overlap = (a: Set<string>, b: Set<string>) =>
  [...a].filter((w) => b.has(w)).length;
const TIER_ORDER: Record<Tier, number> = { own: 0, steered: 1, untouched: 2 };

/** The ranking (docs/reports.md): requested kind, medium, purpose and
 * audience word overlap, tier, full-text rank of the situation against
 * summary and words, recency, then id. */
export function rankMemos<T extends Candidate>(
  memos: T[],
  intent: ReportIntent,
) {
  const purpose = words(intent.purpose);
  const audience = words(intent.audience);
  const keyed = memos.map((m) => ({
    m,
    kind: intent.kind_id !== undefined && m.kind_id === intent.kind_id ? 1 : 0,
    medium: m.medium === intent.medium ? 1 : 0,
    tier: TIER_ORDER[m.tier],
    overlap:
      overlap(purpose, words(m.purpose)) + overlap(audience, words(m.audience)),
  }));
  keyed.sort(
    (a, b) =>
      b.kind - a.kind ||
      b.medium - a.medium ||
      b.overlap - a.overlap ||
      a.tier - b.tier ||
      b.m.lexical - a.m.lexical ||
      (a.m.at < b.m.at ? 1 : a.m.at > b.m.at ? -1 : 0) ||
      a.m.id.localeCompare(b.m.id),
  );
  return keyed.map((k) => k.m);
}

const TIER_LABEL = { own: "your words", steered: "steered by you" } as const;
/** Report text's line breaks (docs/reports.md, "Text"): CRLF as one, then
 * LF, CR, VT, FF, NEL and the line and paragraph separators. A client may
 * break lines at any of them, so memo text may start a line only inside a
 * quoted final. */
export const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g;
/** How many LINE_BREAKs a text holds, in SQL: every break character,
 * less one per CRLF. Plain string functions, not a regular expression,
 * which took six times as long on a 256 KiB final of short lines. */
export const lineBreaks = (text: SQL) =>
  sql`(length(${text})-length(translate(${text},${"\n\r\v\f\u0085\u2028\u2029"},''))-(length(${text})-length(replace(${text},${"\r\n"},'')))/2)`;
/** A final as report text: every line, empty ones included, starts with `>`;
 * each line break is kept as sent. */
export const quote = (body: string) =>
  body
    .split(new RegExp(`(${LINE_BREAK.source})`))
    .map((part, i) => (i % 2 ? part : part === "" ? ">" : `> ${part}`))
    .join("");
/** A one-line field (context, kind label, tweak) as report text: each line
 * break, which older saves could hold, becomes one space. */
export const flat = (text: string) => text.replace(LINE_BREAK, " ");
/** A run of the invisible line and paragraph separators, U+2028 and U+2029:
 * the only code points in Zl and Zp. */
const SEPARATOR_RUN = /[\p{Zl}\p{Zp}]+/gu;
/** The one-line rule (docs/memos.md, "Bounds"), before the trim: each run of
 * separators becomes one space. Also how a cover sheet line is matched and
 * served, so one stored before the rule breaks no line either. */
export const joinSeparators = (text: string) =>
  text.replace(SEPARATOR_RUN, " ");
const exampleHeader = (m: Candidate, kind: string | undefined, n: number) =>
  [
    `## ${n}. ${[kind && flat(kind), m.medium, TIER_LABEL[m.tier as "own"], m.at.slice(0, 10)].filter(Boolean).join(" · ")}`,
    `Situation: ${flat(m.summary)}`,
    ...(m.audience || m.purpose
      ? [
          [
            m.audience ? `Audience: ${flat(m.audience)}` : "",
            m.purpose ? `Purpose: ${flat(m.purpose)}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ]
      : []),
  ].join("\n");

/** Whether a memo's stored changes may be served under it as an example
 * (docs/reports.md, "What they changed"), whatever the report: drafted, with
 * its first draft kept and its changes itemized, steered, and a final small
 * enough to be an example at all. The report asks it of the examples it
 * selected; the memo page asks it directly. */
export const servesChanges = (m: {
  mode: string | null;
  first_draft_state: string;
  changes_state: string | null;
  tier: Tier;
  bytes: number;
}) =>
  m.mode === "draft" &&
  m.first_draft_state === "kept" &&
  m.changes_state === "itemized" &&
  m.tier === "steered" &&
  m.bytes <= MAX_EXAMPLE_BYTES;

/** Examples in rank order within the budget: never untouched finals or ones
 * over MAX_EXAMPLE_BYTES, at most MAX_STEERED steered ones, the top one always.
 * A block's size is counted before its words are fetched, as an upper bound:
 * its header, its words, and a "> " for every line. */
export function selectExamples(
  ranked: Candidate[],
  labels: Map<string, string>,
  budget = EXAMPLE_BUDGET,
) {
  const chosen: Candidate[] = [];
  let bytes = 0;
  let steered = 0;
  for (const m of ranked) {
    if (m.tier === "untouched" || m.bytes > MAX_EXAMPLE_BYTES) continue;
    if (m.tier === "steered" && steered === MAX_STEERED) continue;
    const size =
      utf8Bytes(
        exampleHeader(m, labels.get(m.kind_id ?? ""), chosen.length + 1),
      ) +
      m.bytes +
      2 * (m.lines + 1) +
      2;
    if (chosen.length && bytes + size > budget) continue;
    chosen.push(m);
    bytes += size;
    if (m.tier === "steered") steered++;
  }
  return chosen;
}

/** The tweaks the TWEAK_MEMOS best-matching memos cite, by their best memo's
 * rank, then citation count, at most MAX_TWEAKS. Only memos that cite a tweak
 * are matched: memos of the person's own words cite none. */
export function selectTweaks(
  ranked: Candidate[],
  counts: Map<string, { text: string; memos: number }>,
) {
  const best = new Map<string, number>();
  ranked
    .filter((m) => m.tweaks.length)
    .slice(0, TWEAK_MEMOS)
    .forEach((m, rank) => {
      for (const id of m.tweaks) if (!best.has(id)) best.set(id, rank);
    });
  return [...best]
    .filter(([id]) => counts.has(id))
    .sort(
      ([a, ra], [b, rb]) =>
        ra - rb ||
        counts.get(b)!.memos - counts.get(a)!.memos ||
        a.localeCompare(b),
    )
    .slice(0, MAX_TWEAKS)
    .map(([id]): ServedTweak => {
      const { text, memos } = counts.get(id)!;
      return { tweak_id: id, text, memos };
    });
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
export const EMPTY_REPORT =
  "Nothing similar is on file yet. Write from the cover sheet and the request, and don't claim to know the person's voice.";

/** The report for one draft: the cover sheet, the examples, then the tweaks,
 * and a report_id recording which tweaks it served. Three statements, none in
 * a transaction: the candidates, then the chosen words with the served record.
 * A memo forgotten in between is left out. */
export async function readReport(
  session: StoreSession,
  userId: string,
  intent: ReportIntent,
): Promise<ReportRead> {
  const query = sql`replace(plainto_tsquery('english',${intent.situation})::text,'&','|')::tsquery`;
  const row = (
    await session.query<{
      open: boolean;
      kind_valid: boolean;
      cover: { text: string } | null;
      kinds: { id: string; label: string }[];
      memos: Candidate[];
      tweaks: {
        id: string;
        text: string;
        memos: number;
        served: number;
        needed_again: number;
      }[];
    }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
      ${kindValid(userId, intent.kind_id)} AS kind_valid,
      ${coverSheetJson(userId)} AS cover,
      (SELECT coalesce(json_agg(json_build_object('id',id,'label',label) ORDER BY lower(label),id),'[]'::json)
        FROM memo_kinds WHERE user_id=${userId}) AS kinds,
      (SELECT coalesce(json_agg(json_build_object('id',m.id,'kind_id',m.kind_id,'medium',m.medium,'tier',m.tier,
        'summary',m.summary,'audience',m.audience,'purpose',m.purpose,
        'at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'bytes',octet_length(m.final),
        'lines',${lineBreaks(sql`m.final`)},
        'lexical',ts_rank(m.search,${query}),
        'mode',m.mode,'first_draft_state',m.first_draft_state,'changes_state',m.changes_state,
        'tweaks',(SELECT coalesce(array_agg(c.tweak_id ORDER BY c.tweak_id),'{}') FROM tweak_citations c
          WHERE c.user_id=m.user_id AND c.memo_id=m.id))),'[]'::json)
        FROM memos m WHERE m.user_id=${userId}) AS memos,
      (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text,'memos',
        (SELECT count(*) FROM tweak_citations c WHERE c.user_id=t.user_id AND c.tweak_id=t.id),
        'served',s.served,'needed_again',s.needed_again)),'[]'::json)
        FROM tweaks t ${tweakScore} WHERE t.user_id=${userId}) AS tweaks`)
  )[0]!;
  if (!row.open) throw accountUnavailable();
  if (!row.kind_valid) throw invalidKind();
  const labels = new Map(row.kinds.map((k) => [k.id, k.label]));
  const ranked = rankMemos(row.memos, intent);
  const examples = selectExamples(ranked, labels);
  const scores = new Map(row.tweaks.map((t) => [t.id, t]));
  const tweaks = selectTweaks(ranked, scores);
  const reportId = randomUUID();
  // At most MAX_STEERED memos: their changes come in the statement that
  // fetches the finals, so a memo forgotten before it loses both.
  const withChanges = examples.filter(servesChanges).map((m) => m.id);
  const fetched = await session.query<{
    id: string;
    final: string;
    changes: StoredChange[] | null;
  }>(sql`WITH served AS (
        INSERT INTO served_reports(user_id,id,tweak_ids)
        VALUES (${userId},${reportId},${sql.param(tweaks.map((t) => t.tweak_id))}::text[]))
        SELECT m.id,m.final,CASE WHEN m.id=ANY(${sql.param(withChanges)}::text[]) THEN
          (SELECT coalesce(json_agg(json_build_object('n',c.n,'before',c."before",'after',c."after",
            'truncated',c.truncated,'about',c.about,'by',c.by,'tweak_id',c.tweak_id,
            'draft_start',c.draft_start,'draft_end',c.draft_end,
            'final_start',c.final_start,'final_end',c.final_end) ORDER BY c.n),'[]'::json)
            FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id
              AND ${sql.raw(STORED_SERVABLE_SQL)}) END AS changes
        FROM memos m WHERE m.user_id=${userId}
          AND m.id=ANY(${sql.param(examples.map((m) => m.id))}::text[])`);
  const finals = new Map(fetched.map((m) => [m.id, m.final]));
  const served = examples.filter((m) => finals.has(m.id));
  const rows = new Map(fetched.map((m) => [m.id, m.changes]));
  const { blocks, guidance } = changeBlocks(
    served.flatMap((m) => {
      const r = rows.get(m.id);
      return r ? [{ id: m.id, rows: r }] : [];
    }),
  );
  const cover = row.cover?.text.trim() ? joinSeparators(row.cover.text) : "";
  const parts = [
    ...(cover ? ["# Cover sheet", cover] : []),
    ...(served.length
      ? [
          "# Examples",
          `The person's finals that best match this draft, best first. Imitate their wording.${guidance ? `\n${CHANGES_GUIDANCE}` : ""}`,
          ...served.map(
            (m, i) =>
              `${exampleHeader(m, labels.get(m.kind_id ?? ""), i + 1)}\n\n${quote(finals.get(m.id)!)}${blocks.get(m.id) ?? ""}`,
          ),
        ]
      : []),
    ...(tweaks.length
      ? [
          "# Your tweaks",
          'What the person made an AI change in similar memos, best match first. "needed again" counts drafts that were given the tweak and still needed it.',
          tweaks
            .map((t) => {
              const { served, needed_again } = scores.get(t.tweak_id)!;
              return `- ${flat(t.text)} (${plural(t.memos, "memo")}${needed_again ? `; needed again ${needed_again} of ${served}` : ""})`;
            })
            .join("\n"),
        ]
      : []),
  ];
  const isEmpty = !served.length && !tweaks.length;
  return {
    report_id: reportId,
    text: [...parts, ...(isEmpty ? [EMPTY_REPORT] : [])].join("\n\n"),
    is_empty: isEmpty,
    examples: served.map((m) => ({
      memo_id: m.id,
      ...(m.kind_id
        ? { kind_id: m.kind_id, kind: labels.get(m.kind_id) ?? "" }
        : {}),
      medium: m.medium,
      tier: m.tier as ServedExample["tier"],
      date: m.at.slice(0, 10),
    })),
    tweaks,
    kinds: row.kinds.map((k) => ({ kind_id: k.id, kind: k.label })),
  };
}
