// The TPS page's store: what the person sees of their memos, and the changes
// they make there with their own session (docs/tps-page.md). Every change
// takes the account lock saves take.
import { sql } from "drizzle-orm";
import type { StoreDatabase, StoreSession } from "./database";
import { databaseFailure } from "./database";
import { accountUnavailable, requireActiveAccount } from "./accounts";
import {
  coverSheetJson,
  keepMemos,
  MEDIA,
  servesChanges,
  type Medium,
} from "./memos";
import { changeLine, servableRow } from "./changes";
import { utf8Bytes } from "./limits";
import { deleteMemos } from "./save";
import { scoreboard, type Scoreboard, type Tier } from "./score";

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
  change?: number;
  tier: Tier;
  /** The request's first line, cut to ASKED_LINE characters. */
  asked?: string;
  /** itemized or too_large; absent for a memo saved before changes were
   * listed or without a kept first draft. */
  changes_state?: "itemized" | "too_large";
  /** Its tweaks: every stored change row, in order (docs/memos.md,
   * "Changes"). */
  changes: TpsChange[];
};
export type TpsView = {
  keep_memos: boolean;
  memos: TpsMemo[];
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
  by: string | null;
  tweak_id: string | null;
  draft_start: number | null;
  draft_end: number | null;
  final_start: number | null;
  final_end: number | null;
};
export type FullMemo = TpsMemo & {
  first_draft?: string;
  final: string;
  /** The ask the AI sent for it (asked to be only what the person typed);
   * never served to an AI. */
  request?: string;
  /** Whether a report may serve some of these changes under it as an
   * example, by the report's own rule (docs/reports.md). */
  changes_served: boolean;
};

/** Memos the page lists, newest first. Older ones stay in the export. */
export const LISTED_MEMOS = 200;
/** A listed memo shows its request's first line, cut to this many characters. */
export const ASKED_LINE = 120;

/** Every stored change row of memo `m`, in order. */
const changeRowsJson = sql`(SELECT coalesce(json_agg(json_build_object('n',c.n,'before',c."before",'after',c."after",
    'truncated',c.truncated,'about',c.about,'by',c.by,'tweak_id',c.tweak_id,
    'draft_start',c.draft_start,
    'draft_end',c.draft_end,'final_start',c.final_start,'final_end',c.final_end)
    ORDER BY c.n),'[]'::json)
    FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id)`;
const memoColumns = sql`m.id,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
  m.client_json::jsonb AS client,m.medium,k.label AS kind,m.summary,m.audience,m.purpose,m.mode,
  m.first_draft_state,m.change,m.tier,
  split_part(m.request,E'\n',1) AS asked,
  m.changes_state,${changeRowsJson} AS changes`;
type MemoRow = Omit<
  TpsMemo,
  | "kind"
  | "audience"
  | "purpose"
  | "mode"
  | "change"
  | "asked"
  | "changes_state"
> & {
  kind: string | null;
  audience: string | null;
  purpose: string | null;
  mode: "draft" | "edit" | null;
  change: number | null;
  asked: string | null;
  changes_state: "itemized" | "too_large" | null;
};
const memo = (row: MemoRow): TpsMemo => {
  const {
    kind,
    audience,
    purpose,
    mode,
    change,
    asked,
    changes_state,
    ...rest
  } = row;
  const chars = asked === null ? [] : Array.from(asked);
  return {
    ...rest,
    ...(kind !== null ? { kind } : {}),
    ...(audience !== null ? { audience } : {}),
    ...(purpose !== null ? { purpose } : {}),
    ...(mode !== null ? { mode } : {}),
    ...(change !== null ? { change } : {}),
    ...(asked !== null
      ? {
          asked:
            chars.length > ASKED_LINE
              ? chars.slice(0, ASKED_LINE).join("") + "…"
              : asked,
        }
      : {}),
    ...(changes_state !== null ? { changes_state } : {}),
  };
};

/** Text Markdown shows literally: a fenced block whose fence is longer than
 * any run of tildes inside it, so no heading, list, quote or inline HTML can
 * come from it. */
const fenced = (text: string) => {
  const runs = text.match(/~+/g) ?? [];
  const fence = "~".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
};

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
          keep_memos: boolean;
          memos: MemoRow[];
          scored: {
            mode: "draft" | "edit";
            change: number;
            untouched: boolean;
            at: string;
          }[];
        }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
          ${keepMemos(userId)} AS keep_memos,
          (SELECT coalesce(json_agg(to_jsonb(r)-'created' ORDER BY r.created DESC,r.id),'[]'::json) FROM (
            SELECT ${memoColumns},m.created_at AS created FROM memos m LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
            WHERE m.user_id=${userId} ORDER BY m.created_at DESC,m.id LIMIT ${LISTED_MEMOS}) r) AS memos,
          (SELECT coalesce(json_agg(json_build_object('mode',mode,'change',change,
            'untouched',final=first_draft,'at',created_at) ORDER BY created_at),'[]'::json)
            FROM memos WHERE user_id=${userId} AND first_draft_state='kept' AND change IS NOT NULL) AS scored`)
      )[0]!;
      if (!row.open) throw accountUnavailable();
      return {
        keep_memos: row.keep_memos,
        memos: row.memos.map(memo),
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
        }
      >(sql`SELECT ${memoColumns},m.first_draft,m.final,m.request
        FROM memos m
        LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
        WHERE m.user_id=${userId} AND m.id=${id}`);
      if (!row) return undefined;
      const { first_draft, final, request, ...rest } = row;
      return {
        ...memo(rest),
        ...(first_draft !== null ? { first_draft } : {}),
        final,
        ...(request !== null ? { request } : {}),
        changes_served:
          servesChanges({ ...row, bytes: utf8Bytes(final) }) &&
          row.changes.some(servableRow),
      };
    },
    /** TPS.md (docs/tps-page.md, "TPS.md"): every memo's final grouped by
     * medium, newest first, with what the person asked and its tweaks, then
     * the retired cover sheet and earlier notes, only when present. First
     * drafts stay out. */
    async exportTps(): Promise<string> {
      const [row] = await db.query<{
        open: boolean;
        cover: { text: string } | null;
        notes: string[];
        memos: {
          medium: Medium;
          kind: string | null;
          summary: string;
          at: string;
          final: string;
          request: string | null;
          first_draft_state: "kept" | "missing" | "none";
          changes_state: "itemized" | "too_large" | null;
          changes: TpsChange[];
        }[];
      }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
        ${coverSheetJson(userId)} AS cover,
        (SELECT coalesce(json_agg(t.text ORDER BY t.created_at,t.id),'[]'::json)
          FROM tweaks t WHERE t.user_id=${userId}) AS notes,
        (SELECT coalesce(json_agg(json_build_object('medium',m.medium,'kind',k.label,'summary',m.summary,
          'at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),'final',m.final,'request',m.request,
          'first_draft_state',m.first_draft_state,'changes_state',m.changes_state,
          'changes',${changeRowsJson}) ORDER BY m.created_at DESC,m.id),'[]'::json)
          FROM memos m LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
          WHERE m.user_id=${userId}) AS memos`);
      if (!row!.open) throw accountUnavailable();
      const quote = (text: string) =>
        text
          .split("\n")
          .map((l) => (l === "" ? ">" : `> ${l}`))
          .join("\n");
      // A memo's tweaks: every stored row as changeLine prints it, without
      // the report's filters or budget, or why there are none to list.
      const tweaks = (m: NonNullable<typeof row>["memos"][number]) => {
        if (m.first_draft_state !== "kept") return undefined;
        if (m.changes_state === null)
          return "Changes were not recorded for this memo.";
        if (m.changes_state === "too_large") return "Too many changes to list.";
        if (!m.changes.length) return "No changes were listed.";
        return `Tweaks:\n${fenced(
          m.changes
            .map((c) => changeLine(c) + (c.truncated ? " … [shortened]" : ""))
            .join("\n"),
        )}`;
      };
      const parts = ["# TPS report"];
      for (const medium of MEDIA) {
        const mine = row!.memos.filter((m) => m.medium === medium);
        if (!mine.length) continue;
        parts.push(`## ${medium[0]!.toUpperCase()}${medium.slice(1)}`);
        for (const m of mine) {
          const listed = tweaks(m);
          parts.push(
            `### ${[m.kind, m.at].filter(Boolean).join(" · ")}\n${m.summary}${m.request !== null ? `\nAsked:\n${fenced(m.request)}` : ""}\n\n${quote(m.final)}${listed ? `\n\n${listed}` : ""}`,
          );
        }
      }
      if (row!.cover?.text.trim())
        parts.push("## Cover sheet (no longer used)", fenced(row!.cover.text));
      if (row!.notes.length)
        parts.push(
          "## Earlier notes from your edits (no longer used)",
          fenced(row!.notes.map((note) => `- ${note}`).join("\n")),
        );
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
    setKeepMemos: (keep: boolean) =>
      change(async (tx) => {
        await tx.query(sql`INSERT INTO memo_settings(user_id,keep_memos) VALUES (${userId},${keep})
          ON CONFLICT (user_id) DO UPDATE SET keep_memos=excluded.keep_memos,updated_at=clock_timestamp()`);
      }),
  };
}
export type TpsStore = ReturnType<typeof tpsStore>;
