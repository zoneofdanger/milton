// Memos as AIs read them: the report Milton assembles for one draft
// (docs/reports.md). Reads run no model and write nothing.
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

/** Examples fill by rank within this many UTF-8 bytes, about 8k tokens; the
 * top example is served even over it (docs/reports.md). */
export const EXAMPLE_BUDGET = 32768;
/** A final over this many bytes is kept but never served as an example. */
export const MAX_EXAMPLE_BYTES = 131072;
/** At most this many steered finals per report: they are mostly AI text. */
export const MAX_STEERED = 3;

export type ReportIntent = {
  situation: string;
  medium: Medium;
  audience: string;
  purpose: string;
  kind_id?: string;
};
export type ServedExample = {
  memo_id: string;
  kind_id?: string;
  kind?: string;
  medium: Medium;
  tier: Exclude<Tier, "untouched">;
  date: string;
};
export type Kind = { kind_id: string; kind: string };
export type ReportRead = {
  text: string;
  is_empty: boolean;
  examples: ServedExample[];
  kinds: Kind[];
  /** The account's total memo count, whatever the intent or budget. */
  memos: number;
  keep_memos: boolean;
};

/** The account's retired cover sheet, kept for TPS.md: its latest text and
 * version, 0 before any. */
export const coverSheetJson = (userId: string) =>
  sql`(SELECT json_build_object('version',version,'text',text) FROM cover_sheets WHERE user_id=${userId} ORDER BY version DESC LIMIT 1)`;
export const keepMemos = (userId: string) =>
  sql`coalesce((SELECT keep_memos FROM memo_settings WHERE user_id=${userId}),true)`;

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
/** A one-line field (context, kind label) as report text: each line
 * break, which older saves could hold, becomes one space. */
export const flat = (text: string) => text.replace(LINE_BREAK, " ");
/** A run of the invisible line and paragraph separators, U+2028 and U+2029:
 * the only code points in Zl and Zp. */
const SEPARATOR_RUN = /[\p{Zl}\p{Zp}]+/gu;
/** The one-line rule (docs/memos.md, "Bounds"), before the trim: each run of
 * separators becomes one space. */
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

export const EMPTY_REPORT =
  "Nothing similar is on file yet. Write from the request, and don't claim to know the person's voice.";

/** The report for one draft: the examples, each drafted one with what the
 * person changed in its first draft (docs/reports.md). Two statements, none in
 * a transaction, neither writing: the candidates, with the account's memo
 * count, then the chosen words. A memo forgotten in between is left out. */
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
      keep_memos: boolean;
      kinds: { id: string; label: string }[];
      memos: Candidate[];
    }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
      ${kindValid(userId, intent.kind_id)} AS kind_valid,
      ${keepMemos(userId)} AS keep_memos,
      (SELECT coalesce(json_agg(json_build_object('id',id,'label',label) ORDER BY lower(label),id),'[]'::json)
        FROM memo_kinds WHERE user_id=${userId}) AS kinds,
      (SELECT coalesce(json_agg(json_build_object('id',m.id,'kind_id',m.kind_id,'medium',m.medium,'tier',m.tier,
        'summary',m.summary,'audience',m.audience,'purpose',m.purpose,
        'at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'bytes',octet_length(m.final),
        'lines',${lineBreaks(sql`m.final`)},
        'lexical',ts_rank(m.search,${query}),
        'mode',m.mode,'first_draft_state',m.first_draft_state,'changes_state',m.changes_state)),'[]'::json)
        FROM memos m WHERE m.user_id=${userId}) AS memos`)
  )[0]!;
  if (!row.open) throw accountUnavailable();
  if (!row.kind_valid) throw invalidKind();
  const labels = new Map(row.kinds.map((k) => [k.id, k.label]));
  const ranked = rankMemos(row.memos, intent);
  const examples = selectExamples(ranked, labels);
  // At most MAX_STEERED memos: their changes come in the statement that
  // fetches the finals, so a memo forgotten before it loses both.
  const withChanges = examples.filter(servesChanges).map((m) => m.id);
  const fetched = examples.length
    ? await session.query<{
        id: string;
        final: string;
        changes: StoredChange[] | null;
      }>(sql`SELECT m.id,m.final,CASE WHEN m.id=ANY(${sql.param(withChanges)}::text[]) THEN
          (SELECT coalesce(json_agg(json_build_object('n',c.n,'before',c."before",'after',c."after",
            'truncated',c.truncated,'about',c.about,'by',c.by,'tweak_id',c.tweak_id,
            'draft_start',c.draft_start,'draft_end',c.draft_end,
            'final_start',c.final_start,'final_end',c.final_end) ORDER BY c.n),'[]'::json)
            FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id
              AND ${sql.raw(STORED_SERVABLE_SQL)}) END AS changes
        FROM memos m WHERE m.user_id=${userId}
          AND m.id=ANY(${sql.param(examples.map((m) => m.id))}::text[])`)
    : [];
  const finals = new Map(fetched.map((m) => [m.id, m.final]));
  const served = examples.filter((m) => finals.has(m.id));
  const rows = new Map(fetched.map((m) => [m.id, m.changes]));
  const { blocks, guidance } = changeBlocks(
    served.flatMap((m) => {
      const r = rows.get(m.id);
      return r ? [{ id: m.id, rows: r }] : [];
    }),
  );
  const text = served.length
    ? [
        "# Examples",
        `The person's finals that best match this draft, best first. Imitate their wording.${guidance ? `\n${CHANGES_GUIDANCE}` : ""}`,
        ...served.map(
          (m, i) =>
            `${exampleHeader(m, labels.get(m.kind_id ?? ""), i + 1)}\n\n${quote(finals.get(m.id)!)}${blocks.get(m.id) ?? ""}`,
        ),
      ].join("\n\n")
    : EMPTY_REPORT;
  return {
    text,
    is_empty: !served.length,
    examples: served.map((m) => ({
      memo_id: m.id,
      ...(m.kind_id
        ? { kind_id: m.kind_id, kind: labels.get(m.kind_id) ?? "" }
        : {}),
      medium: m.medium,
      tier: m.tier as ServedExample["tier"],
      date: m.at.slice(0, 10),
    })),
    kinds: row.kinds.map((k) => ({ kind_id: k.id, kind: k.label })),
    // Every memo row is a candidate, so the count is the inventory's size.
    memos: row.memos.length,
    keep_memos: row.keep_memos,
  };
}
