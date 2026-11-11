// One create_memo save, one transaction: replay a known request ID, or check
// the gates, then save a memo, change the cover sheet, forget memos or correct
// one memo's context, and write the receipt with its result. A receipt commits
// with the change or not at all, so a stored receipt always holds the outcome.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { MemoContextInput, MemoInput, SaveMemoInput } from "../mcp-tools";
import {
  databaseFailure,
  type StoreDatabase,
  type StoreSession,
} from "./database";
import { StoreError } from "./errors";
import { MAX_REQUEST_BYTES } from "../http";
import { utf8Bytes } from "./limits";
import { requireActiveAccount } from "./accounts";
import { COVER_SHEET_CHARS, coverSheetJson, keepMemos } from "./memos";
import { change, normalizeTweak, tier } from "./score";
import { createHash } from "node:crypto";
import { assertTrialAccess, type TrialStatus } from "./trials";

export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const savedTweak = z.object({ tweak_id: z.string(), text: z.string() });
const outcomeSchema = z.object({
  status: z.enum(["saved", "unchanged", "conflict", "failed"]),
  request_id: z.string(),
  error: z.string().optional(),
  /** A StoreError's client-facing message; never raw internal text. */
  message: z.string().optional(),
  memo: z
    .object({
      memo_id: z.string(),
      tier: z.enum(["own", "steered", "untouched"]),
      kind_id: z.string().optional(),
      kind: z.string().optional(),
      rounds: z.number().optional(),
      change: z.number().optional(),
      tweaks: z.array(savedTweak),
    })
    .optional(),
  /** The one line the AI tells the person after a saved memo. */
  receipt: z.string().optional(),
  cover_sheet: z.object({ version: z.number(), text: z.string() }).optional(),
  forgotten: z.array(z.string()).optional(),
});
export type SaveOutcome = z.infer<typeof outcomeSchema>;
type Receipt = { input_hash: string; result_json: unknown };
/** The AI a save is attributed to. */
export type Actor = { issuer: string; clientId: string };

async function receipt(tx: StoreSession, userId: string, id: string) {
  return (
    await tx.query<Receipt>(
      sql`SELECT input_hash,result_json FROM save_requests WHERE user_id=${userId} AND request_id=${id}`,
    )
  )[0];
}

/** What a memo's shape gets wrong, checked before any database work, or
 * undefined. Only the first draft decides the rest: with one (or
 * first_draft_missing), mode and rounds are required; without, writing the
 * person gave, none of mode, rounds or tweaks. */
export function memoShapeProblem(memo: MemoInput): string | undefined {
  if (memo.kind_id !== undefined && memo.new_kind !== undefined)
    return "A memo takes kind_id or new_kind, not both.";
  const drafted =
    memo.first_draft !== undefined || memo.first_draft_missing === true;
  if (memo.first_draft !== undefined && memo.first_draft_missing)
    return "Send first_draft or first_draft_missing, not both.";
  if (!drafted)
    return memo.mode !== undefined ||
      memo.rounds !== undefined ||
      memo.tweaks !== undefined
      ? "Writing the person gave you (no first_draft) takes no mode, rounds or tweaks; for a draft you wrote, send first_draft, or first_draft_missing if you no longer have it verbatim."
      : undefined;
  if (memo.mode === undefined || memo.rounds === undefined)
    return "With a first draft, send mode (draft or edit) and rounds (your redrafts after the first draft).";
  if (memo.tweaks !== undefined && memo.first_draft === memo.final)
    return "The final equals the first draft, so this memo teaches no tweaks; omit tweaks.";
  return undefined;
}

export async function runSave(
  db: StoreDatabase,
  userId: string,
  actor: Actor,
  input: SaveMemoInput,
  /** Admits the call (see below); never waits on the database. */
  admit?: () => void,
  /** Sees the trial status the save's gate admitted; a replay never reaches it. */
  gated?: (status: TrialStatus) => void,
): Promise<SaveOutcome> {
  const inputHash = hash(input);
  const result = (
    status: SaveOutcome["status"],
    rest: Partial<SaveOutcome> = {},
  ): SaveOutcome => ({ status, request_id: input.request_id, ...rest });
  const unknown = () =>
    new StoreError(
      "save_outcome_unknown",
      "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
      503,
      { request_id: input.request_id },
    );
  const replay = (existing: Receipt) => {
    if (existing.input_hash !== inputHash)
      throw new StoreError(
        "request_id_reused",
        "This request ID belongs to different input. A changed save needs a new request_id; the original arguments replay the same outcome.",
        409,
      );
    const stored = outcomeSchema.safeParse(existing.result_json);
    // Unreadable only for an outcome stored before memos.
    if (!stored.success) throw unknown();
    return stored.data;
  };
  try {
    return await db.transaction(async (tx) => {
      // Saves take only the account lock. A concurrent save of the same
      // request waits here, then replays.
      await requireActiveAccount(tx, userId, { lock: true });
      const existing = await receipt(tx, userId, input.request_id);
      if (existing) return replay(existing);
      // Account gates answer without a receipt, so the same request can
      // succeed once the gate opens.
      const status = await assertTrialAccess(tx, userId);
      gated?.(status);
      // Admitted here, after replay and every gate: a save that records an
      // outcome is admitted, a replay of it is not. Its usage append runs on
      // another connection, and this transaction never waits on it; the
      // account lock (FOR NO KEY UPDATE) does not block that append's
      // foreign-key check.
      admit?.();
      const decide = async (): Promise<SaveOutcome> => {
        if (utf8Bytes(JSON.stringify(input)) > MAX_REQUEST_BYTES)
          return result("failed", {
            error: "request_too_large",
            message: "The save request is too large. Nothing was changed.",
          });
        // A refusal while applying undoes every change it made, and the
        // receipt stores it, so the same request replays it. A transient or
        // unknown failure (store_unavailable: a timeout, deadlock or lost
        // connection) instead rolls back the whole save, receipt included,
        // so the same request can succeed on retry.
        await tx.query(sql`SAVEPOINT apply`);
        try {
          const save = { tx, userId, actor, input, result };
          if (input.memo) return await saveMemo(save, input.memo);
          if (input.cover_sheet) return await saveCoverSheet(save);
          if (input.forget_memos) return await forgetMemos(save);
          return await correctContext(save, input.memo_context!);
        } catch (error) {
          const failure = databaseFailure(error);
          if (failure.code === "store_unavailable") throw failure;
          await tx.query(sql`ROLLBACK TO SAVEPOINT apply`);
          return result("failed", {
            error: failure.code,
            message: failure.message,
          });
        }
      };
      const outcome = await decide();
      await tx.query(sql`INSERT INTO save_requests(user_id,request_id,input_hash,result_json)
        VALUES (${userId},${input.request_id},${inputHash},${JSON.stringify(outcome)}::jsonb)`);
      return outcome;
    });
  } catch (error) {
    const failure = databaseFailure(error);
    if (failure.code !== "store_unavailable") throw failure;
    // The commit may have landed without its acknowledgment. Under the account
    // lock the receipt answers: present, the save committed; absent, nothing
    // did. Only when that lookup fails too is the outcome unknown.
    let existing: Receipt | undefined;
    try {
      existing = await db.transaction(async (tx) => {
        await requireActiveAccount(tx, userId, { lock: true });
        return receipt(tx, userId, input.request_id);
      });
    } catch {
      throw unknown();
    }
    if (!existing) throw failure;
    return replay(existing);
  }
}

type Save = {
  tx: StoreSession;
  userId: string;
  actor: Actor;
  input: SaveMemoInput;
  result: (
    status: SaveOutcome["status"],
    rest?: Partial<SaveOutcome>,
  ) => SaveOutcome;
};
const client = (actor: Actor) =>
  JSON.stringify({ issuer: actor.issuer, client_id: actor.clientId });

/** The kind a save names: an existing kind_id, or new_kind matched by label
 * in any letter case, created when none matches. */
async function resolveKind(
  tx: StoreSession,
  userId: string,
  kind: { kind_id?: string; new_kind?: string },
): Promise<{ id: string; label: string } | undefined> {
  if (kind.kind_id !== undefined) {
    const [found] = await tx.query<{ id: string; label: string }>(
      sql`SELECT id,label FROM memo_kinds WHERE user_id=${userId} AND id=${kind.kind_id}`,
    );
    if (!found)
      throw new StoreError(
        "invalid_kind",
        "kind_id must name one of the person's kinds from get_report's kinds, or send new_kind. Nothing was changed.",
        400,
      );
    return found;
  }
  if (kind.new_kind === undefined) return undefined;
  const [found] = await tx.query<{ id: string; label: string }>(
    sql`SELECT id,label FROM memo_kinds WHERE user_id=${userId} AND lower(label)=lower(${kind.new_kind})`,
  );
  if (found) return found;
  const id = randomUUID();
  await tx.query(
    sql`INSERT INTO memo_kinds(user_id,id,label) VALUES (${userId},${id},${kind.new_kind})`,
  );
  return { id, label: kind.new_kind };
}

/** The one-line receipt the AI repeats: "Kept memo: vendor decline, 2
 * rounds, tweaks: no warm-up opener." */
export function receiptLine(memo: {
  label: string;
  rounds?: number;
  tweaks: string[];
}) {
  // A tweak's own closing punctuation would double the receipt's.
  const shown = memo.tweaks
    .slice(0, 3)
    .map((tweak) => tweak.replace(/[\s.;,:]+$/u, ""));
  const more = memo.tweaks.length - shown.length;
  return `Kept memo: ${[
    memo.label,
    memo.rounds === undefined
      ? "your words"
      : `${memo.rounds} round${memo.rounds === 1 ? "" : "s"}`,
    ...(shown.length
      ? [`tweaks: ${shown.join("; ")}${more ? ` and ${more} more` : ""}`]
      : []),
  ].join(", ")}.`;
}

async function saveMemo(save: Save, memo: MemoInput): Promise<SaveOutcome> {
  const { tx, userId, actor, input, result } = save;
  const state =
    memo.first_draft !== undefined
      ? "kept"
      : memo.first_draft_missing
        ? "missing"
        : "none";
  const [account] = await tx.query<{ keep: boolean }>(
    sql`SELECT ${keepMemos(userId)} AS keep`,
  );
  if (!account!.keep && state !== "none")
    throw new StoreError(
      "memos_off",
      "The person turned off Keep memos, so drafts are not kept. Nothing was saved.",
      409,
    );
  // A named kind_id is checked first; a new_kind is made only for a memo
  // actually saved, after the duplicate check, so an unchanged resave adds no
  // kind that nothing files under.
  const named =
    memo.kind_id !== undefined
      ? await resolveKind(tx, userId, { kind_id: memo.kind_id })
      : undefined;
  let served: string[] = [];
  if (memo.report_id !== undefined) {
    const [report] = await tx.query<{ tweak_ids: string[] }>(
      sql`SELECT tweak_ids FROM served_reports WHERE user_id=${userId} AND id=${memo.report_id}`,
    );
    if (!report)
      throw new StoreError(
        "invalid_report",
        "report_id must come from one of this person's get_report results. Nothing was saved.",
        400,
      );
    served = report.tweak_ids;
  }
  // The same words already on file: a repeated save keeps one memo, so its
  // tweaks are not counted twice.
  const [same] = await tx.query<{ id: string }>(
    sql`SELECT id FROM memos WHERE user_id=${userId} AND final=${memo.final}
      AND first_draft_state=${state} AND first_draft IS NOT DISTINCT FROM ${memo.first_draft ?? null}
      ORDER BY created_at LIMIT 1`,
  );
  if (same)
    return result("unchanged", {
      memo: await memoSummary(tx, userId, same.id),
    });
  const kind =
    named ?? (await resolveKind(tx, userId, { new_kind: memo.new_kind }));
  // Tweaks: reused ids must be the account's; new text reuses an exact match
  // after normalizing, or is added.
  const ids: string[] = [];
  const texts = new Map<string, string>();
  for (const ref of memo.tweaks ?? []) {
    if ("tweak_id" in ref) {
      const [found] = await tx.query<{ id: string; text: string }>(
        sql`SELECT id,text FROM tweaks WHERE user_id=${userId} AND id=${ref.tweak_id}`,
      );
      if (!found)
        throw new StoreError(
          "invalid_tweak",
          `tweak_id ${JSON.stringify(ref.tweak_id.slice(0, 64))} is not one of this person's tweaks. Nothing was saved.`,
          400,
        );
      if (!texts.has(found.id))
        (ids.push(found.id), texts.set(found.id, found.text));
      continue;
    }
    const norm = normalizeTweak(ref.text);
    if (!norm)
      throw new StoreError(
        "invalid_input",
        "A tweak needs words, not only punctuation. Nothing was saved.",
        400,
      );
    const [found] = await tx.query<{ id: string; text: string }>(sql`
      WITH added AS (
        INSERT INTO tweaks(user_id,id,text,norm,client_json)
        VALUES (${userId},${randomUUID()},${ref.text},${norm},${client(actor)})
        ON CONFLICT (user_id,norm) DO NOTHING RETURNING id,text)
      SELECT id,text FROM added
      UNION ALL SELECT id,text FROM tweaks WHERE user_id=${userId} AND norm=${norm}
      LIMIT 1`);
    if (!texts.has(found!.id))
      (ids.push(found!.id), texts.set(found!.id, found!.text));
  }
  const memoTier = tier({
    state,
    mode: memo.mode,
    firstDraft: memo.first_draft,
    final: memo.final,
    rounds: memo.rounds,
  });
  const score =
    memo.first_draft !== undefined
      ? change(memo.first_draft, memo.final)
      : undefined;
  const id = randomUUID();
  await tx.query(sql`INSERT INTO memos(user_id,id,kind_id,medium,summary,audience,purpose,mode,
      first_draft,first_draft_state,final,rounds,change,tier,report_id,served_tweak_ids,client_json,request_id)
    VALUES (${userId},${id},${kind?.id ?? null},${memo.context.medium},${memo.context.summary},
      ${memo.context.audience ?? null},${memo.context.purpose ?? null},${memo.mode ?? null},
      ${memo.first_draft ?? null},${state},${memo.final},${memo.rounds ?? null},${score ?? null},
      ${memoTier},${memo.report_id ?? null},${sql.param(served)}::text[],${client(actor)},${input.request_id})`);
  if (ids.length)
    await tx.query(sql`INSERT INTO tweak_citations(user_id,memo_id,tweak_id)
      SELECT ${userId}::text,${id}::text,t FROM unnest(${sql.param(ids)}::text[]) AS t`);
  const tweaks = ids.map((tweak_id) => ({
    tweak_id,
    text: texts.get(tweak_id)!,
  }));
  return result("saved", {
    memo: {
      memo_id: id,
      tier: memoTier,
      ...(kind ? { kind_id: kind.id, kind: kind.label } : {}),
      ...(memo.rounds !== undefined ? { rounds: memo.rounds } : {}),
      ...(score !== undefined
        ? { change: Math.round(score * 1000) / 1000 }
        : {}),
      tweaks,
    },
    receipt: receiptLine({
      label: kind?.label ?? memo.context.medium,
      rounds: memo.rounds,
      tweaks: tweaks.map((t) => t.text),
    }),
  });
}

/** A memo already on file, as a saved result describes one. */
async function memoSummary(tx: StoreSession, userId: string, id: string) {
  const [row] = await tx.query<{
    tier: "own" | "steered" | "untouched";
    kind_id: string | null;
    kind: string | null;
    rounds: number | null;
    change: number | null;
    tweaks: { tweak_id: string; text: string }[];
  }>(sql`SELECT m.tier,m.kind_id,k.label AS kind,m.rounds,m.change,
      (SELECT coalesce(json_agg(json_build_object('tweak_id',t.id,'text',t.text) ORDER BY t.id),'[]'::json)
        FROM tweak_citations c JOIN tweaks t ON t.user_id=c.user_id AND t.id=c.tweak_id
        WHERE c.user_id=m.user_id AND c.memo_id=m.id) AS tweaks
    FROM memos m LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
    WHERE m.user_id=${userId} AND m.id=${id}`);
  return {
    memo_id: id,
    tier: row!.tier,
    ...(row!.kind_id ? { kind_id: row!.kind_id, kind: row!.kind ?? "" } : {}),
    ...(row!.rounds !== null ? { rounds: row!.rounds } : {}),
    ...(row!.change !== null
      ? { change: Math.round(row!.change * 1000) / 1000 }
      : {}),
    tweaks: row!.tweaks,
  };
}

/** The cover sheet's lines, as add and remove see them. */
export const coverLines = (text: string) =>
  text === "" ? [] : text.split("\n");
export const coverSheetLimit = (length: number) =>
  new StoreError(
    "cover_sheet_limit",
    `The cover sheet would be ${length.toLocaleString("en-US")} characters, over its ${COVER_SHEET_CHARS.toLocaleString("en-US")}-character limit. Nothing was changed.`,
    422,
  );

async function saveCoverSheet(save: Save): Promise<SaveOutcome> {
  const { tx, userId, actor, input, result } = save;
  const change = input.cover_sheet!;
  const [row] = await tx.query<{
    cover: { version: number; text: string } | null;
  }>(sql`SELECT ${coverSheetJson(userId)} AS cover`);
  const current = {
    version: row!.cover?.version ?? 0,
    text: row!.cover?.text ?? "",
  };
  if (change.expected_version !== current.version)
    return result("conflict", { cover_sheet: current });
  const lines = coverLines(current.text);
  let next: string[];
  if (change.add !== undefined) {
    if (lines.includes(change.add))
      return result("unchanged", { cover_sheet: current });
    next = [...lines, change.add];
  } else {
    if (!lines.includes(change.remove!))
      throw new StoreError(
        "line_not_found",
        "remove must be one whole line copied exactly from the current cover sheet. Nothing was changed.",
        409,
      );
    // Removing the last line may empty it (docs/memos.md).
    next = lines.filter((l) => l !== change.remove);
  }
  const text = next.join("\n");
  if (text.length > COVER_SHEET_CHARS) throw coverSheetLimit(text.length);
  const version = current.version + 1;
  await tx.query(sql`INSERT INTO cover_sheets(user_id,version,text,actor_json)
    VALUES (${userId},${version},${text},${JSON.stringify({ kind: "ai", ...JSON.parse(client(actor)) })})`);
  return result("saved", { cover_sheet: { version, text } });
}

/** Deletes memos and, through the citations' cascade, what they taught; a
 * tweak left with no citation goes too. Shared with the TPS page. */
export async function deleteMemos(
  tx: StoreSession,
  userId: string,
  ids: string[] | "all",
) {
  const gone = await tx.query<{ id: string }>(
    ids === "all"
      ? sql`DELETE FROM memos WHERE user_id=${userId} RETURNING id`
      : sql`DELETE FROM memos WHERE user_id=${userId} AND id=ANY(${sql.param(ids)}::text[]) RETURNING id`,
  );
  if (gone.length)
    await tx.query(sql`DELETE FROM tweaks t WHERE t.user_id=${userId}
      AND NOT EXISTS(SELECT 1 FROM tweak_citations c WHERE c.user_id=t.user_id AND c.tweak_id=t.id)`);
  return gone.map((m) => m.id).sort();
}

async function forgetMemos(save: Save): Promise<SaveOutcome> {
  const { tx, userId, input, result } = save;
  const forgotten = await deleteMemos(tx, userId, [
    ...new Set(input.forget_memos!),
  ]);
  if (!forgotten.length)
    throw new StoreError(
      "invalid_memo",
      "None of those ids is one of this person's memos. Nothing was changed.",
      404,
    );
  return result("saved", { forgotten });
}

async function correctContext(
  save: Save,
  change: {
    memo_id: string;
    context: MemoContextInput;
    kind_id?: string;
    new_kind?: string;
  },
): Promise<SaveOutcome> {
  const { tx, userId, result } = save;
  if (change.kind_id !== undefined && change.new_kind !== undefined)
    throw new StoreError(
      "invalid_input",
      "memo_context takes kind_id or new_kind, not both. Nothing was changed.",
      400,
    );
  const kind = await resolveKind(tx, userId, change);
  const c = change.context;
  const [row] = await tx.query<{ changed: boolean | null }>(sql`
    WITH old AS (SELECT * FROM memos WHERE user_id=${userId} AND id=${change.memo_id} FOR UPDATE),
    updated AS (
      UPDATE memos m SET medium=${c.medium},summary=${c.summary},audience=${c.audience ?? null},
        purpose=${c.purpose ?? null},kind_id=${kind ? kind.id : sql`m.kind_id`},context_updated_at=clock_timestamp()
      FROM old WHERE m.user_id=old.user_id AND m.id=old.id
        AND (old.medium,old.summary,old.audience,old.purpose,old.kind_id) IS DISTINCT FROM
          (${c.medium},${c.summary},${c.audience ?? null}::text,${c.purpose ?? null}::text,${kind ? kind.id : sql`old.kind_id`})
      RETURNING 1)
    SELECT EXISTS(SELECT 1 FROM updated) AS changed FROM old`);
  if (!row)
    throw new StoreError(
      "invalid_memo",
      "memo_id is not one of this person's memos. Nothing was changed.",
      404,
    );
  const memo = await memoSummary(tx, userId, change.memo_id);
  return result(row.changed ? "saved" : "unchanged", { memo });
}
