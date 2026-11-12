// The TPS page's store: what the person sees of their memos, and the changes
// they make there with their own session (docs/tps-page.md). Every change
// takes the account lock saves take.
import { sql } from "drizzle-orm";
import type { StoreDatabase, StoreSession } from "./database";
import { databaseFailure } from "./database";
import { accountUnavailable, requireActiveAccount } from "./accounts";
import { StoreError } from "./errors";
import {
  coverSheetJson,
  keepMemos,
  MEDIA,
  tweakScore,
  type Medium,
} from "./memos";
import { deleteMemos } from "./save";
import {
  normalizeTweak,
  scoreboard,
  type Scoreboard,
  type Tier,
} from "./score";

export type TpsMemo = {
  id: string;
  at: string;
  client: { issuer: string; client_id: string };
  medium: Medium;
  kind?: string;
  summary: string;
  audience?: string;
  purpose?: string;
  mode?: "draft" | "edit";
  first_draft_state: "kept" | "missing" | "none";
  rounds?: number;
  change?: number;
  tier: Tier;
  /** The request's first line, cut to ASKED_LINE characters. */
  asked?: string;
  /** How many changes its memo page lists, Markdown-only ones included (none
   * for a too_large memo); absent for a memo saved before changes were
   * listed. */
  change_count?: number;
  /** Tweaks the report before it served, still on file. */
  served: { id: string; text: string }[];
  /** Tweaks it cites. */
  taught: { id: string; text: string }[];
};
/** A tweak with its citation count and its score (docs/reports.md). */
export type TpsTweak = {
  id: string;
  text: string;
  memos: number;
  served: number;
  needed_again: number;
};
export type TpsView = {
  cover_sheet: { text: string; version: number };
  keep_memos: boolean;
  memos: TpsMemo[];
  tweaks: TpsTweak[];
  scoreboard: Scoreboard[];
};
/** One stored change, code's own spot, as the memo page lists it
 * (docs/memos.md, "Changes"). */
export type TpsChange = {
  n: number;
  before: string;
  after: string;
  /** A side was cut at 300 characters. */
  truncated: boolean;
  /** "format" for a Markdown-only spot; no other label. */
  about: "format" | null;
  draft_start: number | null;
  draft_end: number | null;
  final_start: number | null;
  final_end: number | null;
};
export type FullMemo = TpsMemo & {
  first_draft?: string;
  final: string;
  /** What the person typed to ask for it; never served to an AI. */
  request?: string;
  /** itemized or too_large; absent for a memo saved before changes were
   * listed or without a kept first draft. */
  changes_state?: "itemized" | "too_large";
  changes: TpsChange[];
};

/** Memos the page lists, newest first. Older ones stay in the export. */
export const LISTED_MEMOS = 200;
/** A listed memo shows its request's first line, cut to this many characters. */
export const ASKED_LINE = 120;

const memoColumns = sql`m.id,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
  m.client_json::jsonb AS client,m.medium,k.label AS kind,m.summary,m.audience,m.purpose,m.mode,
  m.first_draft_state,m.rounds,m.change,m.tier,
  (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text) ORDER BY array_position(m.served_tweak_ids,t.id)),'[]'::json)
    FROM tweaks t WHERE t.user_id=m.user_id AND t.id=ANY(m.served_tweak_ids)) AS served,
  (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text) ORDER BY t.text,t.id),'[]'::json)
    FROM tweak_citations c JOIN tweaks t ON t.user_id=c.user_id AND t.id=c.tweak_id
    WHERE c.user_id=m.user_id AND c.memo_id=m.id) AS taught,
  split_part(m.request,E'\n',1) AS asked,
  CASE WHEN m.changes_state IS NOT NULL THEN (SELECT count(*)::int FROM memo_changes c
    WHERE c.user_id=m.user_id AND c.memo_id=m.id) END AS change_count`;
type MemoRow = Omit<
  TpsMemo,
  | "kind"
  | "audience"
  | "purpose"
  | "mode"
  | "rounds"
  | "change"
  | "asked"
  | "change_count"
> & {
  kind: string | null;
  audience: string | null;
  purpose: string | null;
  mode: "draft" | "edit" | null;
  rounds: number | null;
  change: number | null;
  asked: string | null;
  change_count: number | null;
};
const memo = (row: MemoRow): TpsMemo => {
  const {
    kind,
    audience,
    purpose,
    mode,
    rounds,
    change,
    asked,
    change_count,
    ...rest
  } = row;
  const chars = asked === null ? [] : Array.from(asked);
  return {
    ...rest,
    ...(kind !== null ? { kind } : {}),
    ...(audience !== null ? { audience } : {}),
    ...(purpose !== null ? { purpose } : {}),
    ...(mode !== null ? { mode } : {}),
    ...(rounds !== null ? { rounds } : {}),
    ...(change !== null ? { change } : {}),
    ...(asked !== null
      ? {
          asked:
            chars.length > ASKED_LINE
              ? chars.slice(0, ASKED_LINE).join("") + "…"
              : asked,
        }
      : {}),
    ...(change_count !== null ? { change_count } : {}),
  };
};

// Each tweak with its count and score (docs/reports.md).
const tweakColumns = (
  userId: string,
) => sql`(SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text,'memos',
    (SELECT count(*) FROM tweak_citations c WHERE c.user_id=t.user_id AND c.tweak_id=t.id),
    'served',s.served,'needed_again',s.needed_again) ORDER BY t.text,t.id),'[]'::json)
    FROM tweaks t ${tweakScore} WHERE t.user_id=${userId})`;
/** Most cited first. */
const tweakList = (rows: TpsTweak[]): TpsTweak[] =>
  rows.toSorted((a, b) => b.memos - a.memos || a.text.localeCompare(b.text));

export function tpsStore(db: StoreDatabase, userId: string) {
  /** One change in one transaction under the account lock. */
  const change = <T>(work: (tx: StoreSession) => Promise<T>) =>
    db
      .transaction(async (tx) => {
        await requireActiveAccount(tx, userId, { lock: true });
        return work(tx);
      })
      .catch((error: unknown) => {
        throw databaseFailure(error);
      });
  return {
    /** Everything the page shows, in one statement. */
    async read(): Promise<TpsView> {
      const row = (
        await db.query<{
          open: boolean;
          cover: { version: number; text: string } | null;
          keep_memos: boolean;
          memos: MemoRow[];
          tweaks: TpsTweak[];
          scored: {
            mode: "draft" | "edit";
            rounds: number;
            change: number;
            untouched: boolean;
            at: string;
          }[];
        }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
          ${coverSheetJson(userId)} AS cover,
          ${keepMemos(userId)} AS keep_memos,
          (SELECT coalesce(json_agg(to_jsonb(r)-'created' ORDER BY r.created DESC,r.id),'[]'::json) FROM (
            SELECT ${memoColumns},m.created_at AS created FROM memos m LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
            WHERE m.user_id=${userId} ORDER BY m.created_at DESC,m.id LIMIT ${LISTED_MEMOS}) r) AS memos,
          ${tweakColumns(userId)} AS tweaks,
          (SELECT coalesce(json_agg(json_build_object('mode',mode,'rounds',rounds,'change',change,
            'untouched',final=first_draft,'at',created_at) ORDER BY created_at),'[]'::json)
            FROM memos WHERE user_id=${userId} AND first_draft_state='kept' AND change IS NOT NULL) AS scored`)
      )[0]!;
      if (!row.open) throw accountUnavailable();
      return {
        cover_sheet: {
          text: row.cover?.text ?? "",
          version: row.cover?.version ?? 0,
        },
        keep_memos: row.keep_memos,
        memos: row.memos.map(memo),
        tweaks: tweakList(row.tweaks),
        scoreboard: scoreboard(
          row.scored.map((s) => ({ ...s, at: new Date(s.at) })),
        ),
      };
    },
    async readMemo(id: string): Promise<FullMemo | undefined> {
      const [row] = await db.query<
        MemoRow & {
          first_draft: string | null;
          final: string;
          request: string | null;
          changes_state: "itemized" | "too_large" | null;
          changes: TpsChange[];
        }
      >(sql`SELECT ${memoColumns},m.first_draft,m.final,m.request,m.changes_state,
        (SELECT coalesce(json_agg(json_build_object('n',c.n,'before',c."before",'after',c."after",
          'truncated',c.truncated,'about',c.about,'draft_start',c.draft_start,
          'draft_end',c.draft_end,'final_start',c.final_start,'final_end',c.final_end)
          ORDER BY c.n),'[]'::json)
          FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id) AS changes
        FROM memos m
        LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
        WHERE m.user_id=${userId} AND m.id=${id}`);
      if (!row) return undefined;
      const { first_draft, final, request, changes_state, changes, ...rest } =
        row;
      return {
        ...memo(rest),
        ...(first_draft !== null ? { first_draft } : {}),
        final,
        ...(request !== null ? { request } : {}),
        ...(changes_state !== null ? { changes_state } : {}),
        changes,
      };
    },
    /** TPS.md: the cover sheet, the tweaks, and every memo's final grouped by
     * medium, newest first, with what the person asked. First drafts and
     * changes stay out. */
    async exportTps(): Promise<string> {
      const [row] = await db.query<{
        open: boolean;
        cover: { text: string } | null;
        tweaks: TpsTweak[];
        memos: {
          medium: Medium;
          kind: string | null;
          summary: string;
          at: string;
          final: string;
          request: string | null;
        }[];
      }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
        ${coverSheetJson(userId)} AS cover,
        ${tweakColumns(userId)} AS tweaks,
        (SELECT coalesce(json_agg(json_build_object('medium',m.medium,'kind',k.label,'summary',m.summary,
          'at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),'final',m.final,'request',m.request) ORDER BY m.created_at DESC,m.id),'[]'::json)
          FROM memos m LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
          WHERE m.user_id=${userId}) AS memos`);
      if (!row!.open) throw accountUnavailable();
      const quote = (text: string) =>
        text
          .split("\n")
          .map((l) => (l === "" ? ">" : `> ${l}`))
          .join("\n");
      // A request's later lines are indented four spaces, so none can start
      // a heading, list, quote or fence: the request stays in its memo.
      const asked = (request: string) =>
        `Asked: ${request.split("\n").join("\n    ")}`;
      const parts = ["# TPS report"];
      if (row!.cover?.text.trim())
        parts.push("## Cover sheet", row!.cover.text);
      if (row!.tweaks.length)
        parts.push(
          "## Tweaks",
          tweakList(row!.tweaks)
            .map(
              (t) =>
                `- ${t.text} (${t.memos} memo${t.memos === 1 ? "" : "s"}${t.served ? `; served ${t.served}, needed again ${t.needed_again}` : ""})`,
            )
            .join("\n"),
        );
      for (const medium of MEDIA) {
        const mine = row!.memos.filter((m) => m.medium === medium);
        if (!mine.length) continue;
        parts.push(`## ${medium[0]!.toUpperCase()}${medium.slice(1)}`);
        for (const m of mine)
          parts.push(
            `### ${[m.kind, m.at].filter(Boolean).join(" · ")}\n${m.summary}${m.request !== null ? `\n${asked(m.request)}` : ""}\n\n${quote(m.final)}`,
          );
      }
      return parts.join("\n\n") + "\n";
    },
    /** Clears a memo's request, the person's own ask; its words stay. */
    removeRequest: (id: string) =>
      change(
        async (tx) =>
          (
            await tx.query(
              sql`UPDATE memos SET request=NULL WHERE user_id=${userId} AND id=${id} RETURNING id`,
            )
          ).length > 0,
      ),
    forgetMemo: (id: string) =>
      change(async (tx) => (await deleteMemos(tx, userId, [id])).length > 0),
    deleteAllMemos: () =>
      change(async (tx) => {
        const gone = await deleteMemos(tx, userId, "all");
        await tx.query(sql`DELETE FROM tweaks WHERE user_id=${userId}`);
        await tx.query(sql`DELETE FROM memo_kinds WHERE user_id=${userId}`);
        return gone.length;
      }),
    deleteTweak: (id: string) =>
      change(
        async (tx) =>
          (
            await tx.query(
              sql`DELETE FROM tweaks WHERE user_id=${userId} AND id=${id} RETURNING id`,
            )
          ).length > 0,
      ),
    /** A reworded tweak keeps its id and citations, and its score restarts
     * from the new text. A wording another tweak already has is refused, so
     * each wording stays one tweak. */
    rewordTweak: (id: string, text: string) =>
      change(async (tx) => {
        const trimmed = text.trim();
        const norm = normalizeTweak(trimmed);
        if (!norm || trimmed.length > 200 || /[\p{Cc}]/u.test(trimmed))
          throw new StoreError(
            "invalid_input",
            "A tweak is one line of at most 200 characters.",
            400,
          );
        const [other] = await tx.query(
          sql`SELECT 1 FROM tweaks WHERE user_id=${userId} AND norm=${norm} AND id<>${id}`,
        );
        if (other)
          throw new StoreError(
            "tweak_exists",
            "Another tweak already says that.",
            409,
          );
        return (
          (
            await tx.query(
              sql`UPDATE tweaks SET text=${trimmed},norm=${norm},
                text_changed_at=CASE WHEN text IS DISTINCT FROM ${trimmed} THEN clock_timestamp() ELSE text_changed_at END
                WHERE user_id=${userId} AND id=${id} RETURNING id`,
            )
          ).length > 0
        );
      }),
    setKeepMemos: (keep: boolean) =>
      change(async (tx) => {
        await tx.query(sql`INSERT INTO memo_settings(user_id,keep_memos) VALUES (${userId},${keep})
          ON CONFLICT (user_id) DO UPDATE SET keep_memos=excluded.keep_memos,updated_at=clock_timestamp()`);
      }),
  };
}
export type TpsStore = ReturnType<typeof tpsStore>;
