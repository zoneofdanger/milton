// Memos as AIs read them: the cover sheet read, and the report Milton assembles
// for one draft (docs/reports.md). Reads run no model.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";
import { accountUnavailable } from "./accounts";
import { StoreError } from "./errors";
import { utf8Bytes } from "./limits";
import { tokens, type Tier } from "./score";

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
    text,
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
const quote = (body: string) =>
  body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
const exampleHeader = (m: Candidate, kind: string | undefined, n: number) =>
  [
    `## ${n}. ${[kind, m.medium, TIER_LABEL[m.tier as "own"], m.at.slice(0, 10)].filter(Boolean).join(" · ")}`,
    `Situation: ${m.summary}`,
    ...(m.audience || m.purpose
      ? [
          [
            m.audience ? `Audience: ${m.audience}` : "",
            m.purpose ? `Purpose: ${m.purpose}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ]
      : []),
  ].join("\n");

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
    .map(([id]): ServedTweak => ({ tweak_id: id, ...counts.get(id)! }));
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
      tweaks: { id: string; text: string; memos: number }[];
    }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
      ${kindValid(userId, intent.kind_id)} AS kind_valid,
      ${coverSheetJson(userId)} AS cover,
      (SELECT coalesce(json_agg(json_build_object('id',id,'label',label) ORDER BY lower(label),id),'[]'::json)
        FROM memo_kinds WHERE user_id=${userId}) AS kinds,
      (SELECT coalesce(json_agg(json_build_object('id',m.id,'kind_id',m.kind_id,'medium',m.medium,'tier',m.tier,
        'summary',m.summary,'audience',m.audience,'purpose',m.purpose,
        'at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'bytes',octet_length(m.final),
        'lines',length(m.final)-length(replace(m.final,E'\\n','')),
        'lexical',ts_rank(m.search,${query}),
        'tweaks',(SELECT coalesce(array_agg(c.tweak_id ORDER BY c.tweak_id),'{}') FROM tweak_citations c
          WHERE c.user_id=m.user_id AND c.memo_id=m.id))),'[]'::json)
        FROM memos m WHERE m.user_id=${userId}) AS memos,
      (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text,'memos',
        (SELECT count(*) FROM tweak_citations c WHERE c.user_id=t.user_id AND c.tweak_id=t.id))),'[]'::json)
        FROM tweaks t WHERE t.user_id=${userId}) AS tweaks`)
  )[0]!;
  if (!row.open) throw accountUnavailable();
  if (!row.kind_valid) throw invalidKind();
  const labels = new Map(row.kinds.map((k) => [k.id, k.label]));
  const ranked = rankMemos(row.memos, intent);
  const examples = selectExamples(ranked, labels);
  const tweaks = selectTweaks(
    ranked,
    new Map(row.tweaks.map((t) => [t.id, { text: t.text, memos: t.memos }])),
  );
  const reportId = randomUUID();
  const finals = new Map(
    (
      await session.query<{ id: string; final: string }>(sql`WITH served AS (
        INSERT INTO served_reports(user_id,id,tweak_ids)
        VALUES (${userId},${reportId},${sql.param(tweaks.map((t) => t.tweak_id))}::text[]))
        SELECT id,final FROM memos WHERE user_id=${userId}
          AND id=ANY(${sql.param(examples.map((m) => m.id))}::text[])`)
    ).map((m) => [m.id, m.final]),
  );
  const served = examples.filter((m) => finals.has(m.id));
  const cover = row.cover?.text.trim() ? row.cover.text : "";
  const parts = [
    ...(cover ? ["# Cover sheet", cover] : []),
    ...(served.length
      ? [
          "# Examples",
          "The person's finals that best match this draft, best first. Imitate their wording.",
          ...served.map(
            (m, i) =>
              `${exampleHeader(m, labels.get(m.kind_id ?? ""), i + 1)}\n\n${quote(finals.get(m.id)!)}`,
          ),
        ]
      : []),
    ...(tweaks.length
      ? [
          "# Your tweaks",
          "What the person made an AI change in similar memos, best match first.",
          tweaks
            .map((t) => `- ${t.text} (${plural(t.memos, "memo")})`)
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
