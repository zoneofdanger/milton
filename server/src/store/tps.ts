// The TPS page's store: what the person sees of their memos, and the changes
// they make there with their own session (SPEC.md, "Where the person sees and
// controls it"). Every change takes the account lock saves take.
import { sql } from "drizzle-orm";
import type { StoreDatabase, StoreSession } from "./database";
import { databaseFailure } from "./database";
import { accountUnavailable, requireActiveAccount } from "./accounts";
import { StoreError } from "./errors";
import {
  COVER_SHEET_CHARS,
  coverSheetJson,
  keepMemos,
  MEDIA,
  type Medium,
} from "./memos";
import { coverSheetLimit, deleteMemos } from "./save";
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
  /** Tweaks the report before it served, still on file. */
  served: { id: string; text: string }[];
  /** Tweaks it cites. */
  taught: { id: string; text: string }[];
};
export type TpsTweak = { id: string; text: string; memos: number };
export type TpsView = {
  cover_sheet: { text: string; version: number };
  keep_memos: boolean;
  memos: TpsMemo[];
  tweaks: TpsTweak[];
  scoreboard: Scoreboard[];
};
export type FullMemo = TpsMemo & { first_draft?: string; final: string };

/** Memos the page lists, newest first. Older ones stay in the export. */
export const LISTED_MEMOS = 200;

const memoColumns = sql`m.id,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
  m.client_json::jsonb AS client,m.medium,k.label AS kind,m.summary,m.audience,m.purpose,m.mode,
  m.first_draft_state,m.rounds,m.change,m.tier,
  (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text) ORDER BY array_position(m.served_tweak_ids,t.id)),'[]'::json)
    FROM tweaks t WHERE t.user_id=m.user_id AND t.id=ANY(m.served_tweak_ids)) AS served,
  (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text) ORDER BY t.text,t.id),'[]'::json)
    FROM tweak_citations c JOIN tweaks t ON t.user_id=c.user_id AND t.id=c.tweak_id
    WHERE c.user_id=m.user_id AND c.memo_id=m.id) AS taught`;
type MemoRow = Omit<
  TpsMemo,
  "kind" | "audience" | "purpose" | "mode" | "rounds" | "change"
> & {
  kind: string | null;
  audience: string | null;
  purpose: string | null;
  mode: "draft" | "edit" | null;
  rounds: number | null;
  change: number | null;
};
const memo = (row: MemoRow): TpsMemo => {
  const { kind, audience, purpose, mode, rounds, change, ...rest } = row;
  return {
    ...rest,
    ...(kind !== null ? { kind } : {}),
    ...(audience !== null ? { audience } : {}),
    ...(purpose !== null ? { purpose } : {}),
    ...(mode !== null ? { mode } : {}),
    ...(rounds !== null ? { rounds } : {}),
    ...(change !== null ? { change } : {}),
  };
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
          (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text,'memos',
            (SELECT count(*) FROM tweak_citations c WHERE c.user_id=t.user_id AND c.tweak_id=t.id)) ORDER BY t.text,t.id),'[]'::json)
            FROM tweaks t WHERE t.user_id=${userId}) AS tweaks,
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
        tweaks: row.tweaks.toSorted(
          (a, b) => b.memos - a.memos || a.text.localeCompare(b.text),
        ),
        scoreboard: scoreboard(
          row.scored.map((s) => ({ ...s, at: new Date(s.at) })),
        ),
      };
    },
    async readMemo(id: string): Promise<FullMemo | undefined> {
      const [row] = await db.query<
        MemoRow & { first_draft: string | null; final: string }
      >(sql`SELECT ${memoColumns},m.first_draft,m.final FROM memos m
        LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
        WHERE m.user_id=${userId} AND m.id=${id}`);
      if (!row) return undefined;
      const { first_draft, final, ...rest } = row;
      return {
        ...memo(rest),
        ...(first_draft !== null ? { first_draft } : {}),
        final,
      };
    },
    /** TPS.md: the cover sheet, the tweaks, and every memo's final grouped by
     * medium, newest first. */
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
        }[];
      }>(sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
        ${coverSheetJson(userId)} AS cover,
        (SELECT coalesce(json_agg(json_build_object('id',t.id,'text',t.text,'memos',
          (SELECT count(*) FROM tweak_citations c WHERE c.user_id=t.user_id AND c.tweak_id=t.id)) ORDER BY t.text,t.id),'[]'::json)
          FROM tweaks t WHERE t.user_id=${userId}) AS tweaks,
        (SELECT coalesce(json_agg(json_build_object('medium',m.medium,'kind',k.label,'summary',m.summary,
          'at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),'final',m.final) ORDER BY m.created_at DESC,m.id),'[]'::json)
          FROM memos m LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
          WHERE m.user_id=${userId}) AS memos`);
      if (!row!.open) throw accountUnavailable();
      const quote = (text: string) =>
        text
          .split("\n")
          .map((l) => (l === "" ? ">" : `> ${l}`))
          .join("\n");
      const parts = ["# TPS report"];
      if (row!.cover?.text.trim())
        parts.push("## Cover sheet", row!.cover.text);
      if (row!.tweaks.length)
        parts.push(
          "## Tweaks",
          row!.tweaks
            .toSorted(
              (a, b) => b.memos - a.memos || a.text.localeCompare(b.text),
            )
            .map(
              (t) => `- ${t.text} (${t.memos} memo${t.memos === 1 ? "" : "s"})`,
            )
            .join("\n"),
        );
      for (const medium of MEDIA) {
        const mine = row!.memos.filter((m) => m.medium === medium);
        if (!mine.length) continue;
        parts.push(`## ${medium[0]!.toUpperCase()}${medium.slice(1)}`);
        for (const m of mine)
          parts.push(
            `### ${[m.kind, m.at].filter(Boolean).join(" · ")}\n${m.summary}\n\n${quote(m.final)}`,
          );
      }
      return parts.join("\n\n") + "\n";
    },
    /** The form's full rewrite, fenced on the version the page showed. */
    saveCoverSheet: (text: string, expectedVersion: number) =>
      change(async (tx) => {
        const normalized = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
        if (normalized.length > COVER_SHEET_CHARS)
          throw coverSheetLimit(normalized.length);
        const [row] = await tx.query<{
          cover: { version: number; text: string } | null;
        }>(sql`SELECT ${coverSheetJson(userId)} AS cover`);
        const version = row!.cover?.version ?? 0;
        if (version !== expectedVersion)
          return { status: "conflict" as const, version };
        if ((row!.cover?.text ?? "") === normalized)
          return { status: "unchanged" as const, version };
        await tx.query(sql`INSERT INTO cover_sheets(user_id,version,text,actor_json)
          VALUES (${userId},${version + 1},${normalized},'{"kind":"person"}')`);
        return { status: "saved" as const, version: version + 1 };
      }),
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
    /** A reworded tweak keeps its id and citations. A wording another tweak
     * already has is refused, so each wording stays one tweak. */
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
              sql`UPDATE tweaks SET text=${trimmed},norm=${norm} WHERE user_id=${userId} AND id=${id} RETURNING id`,
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
