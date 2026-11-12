// One create_memo save, one transaction: replay a known request ID, or check
// the gates, then save a memo, forget memos or correct one memo's context, and
// write the receipt with its result. A receipt commits
// with the change or not at all, so a stored receipt always holds the outcome.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { MemoContextInput, MemoInput, SaveMemoInput } from "../mcp-tools";
import {
  changeList,
  changeRows,
  type ChangeList,
  type ChangeRow,
} from "./changes";
import {
  databaseFailure,
  type StoreDatabase,
  type StoreSession,
} from "./database";
import { StoreError } from "./errors";
import { MAX_REQUEST_BYTES } from "../http";
import { utf8Bytes } from "./limits";
import { requireActiveAccount } from "./accounts";
import { keepMemos } from "./memos";
import { change, tier } from "./score";
import { createHash } from "node:crypto";
import { assertTrialAccess, type TrialStatus } from "./trials";

export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const savedTweak = z.object({ tweak_id: z.string(), text: z.string() });
/** A stored outcome as the decoder reads it. Outcomes saved before this
 * release may hold fields Milton no longer writes (a memo's rounds and
 * tweaks, a cover_sheet), so the decoder keeps accepting them; a fresh outcome
 * has none of them. */
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
      /** Historical receipts only. */
      rounds: z.number().optional(),
      change: z.number().optional(),
      /** Historical receipts only: tweaks an AI wrote. */
      tweaks: z.array(savedTweak).optional(),
      /** Counts only: a receipt outlives forgetting, so it holds no quote. */
      changes: z
        .object({
          state: z.enum(["itemized", "too_large"]),
          found: z.number(),
        })
        .optional(),
    })
    .optional(),
  /** The one line the AI tells the person after a saved memo. */
  receipt: z.string().optional(),
  /** Historical receipts only: a cover sheet change. */
  cover_sheet: z.object({ version: z.number(), text: z.string() }).optional(),
  forgotten: z.array(z.string()).optional(),
});
/** What a replay adds beside the stored outcome, which it returns as stored
 * (docs/saves.md, "Replay"). */
export const REPLAYED =
  "A stored outcome from an earlier save. Fields Milton no longer uses, such as rounds and tweaks, are not current guidance, and this receipt doesn't prove the memo is still on file.";
export type SaveOutcome = z.infer<typeof outcomeSchema> & {
  replayed?: string;
};
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

/** What a memo save with a kept first draft brings beyond its words: the
 * spots code found between it and its final, each an unlabelled row. */
export type Evidence = { state: ChangeList["state"]; rows: ChangeRow[] };
export type MemoCheck =
  | { ok: true; evidence?: Evidence }
  | {
      ok: false;
      message: string;
      /** Selects the refusal's own next step (mcp-outcomes, nextSteps). */
      field?: "request";
    };

/** Lines that look like quoted or forwarded mail: a line starting >, an "On
 * … wrote:" line, or a From or Subject header. This is all the check sees; it
 * cannot tell other pasted text from typed text, so the AI is asked to send
 * only what the person typed (docs/memos.md, "The request"). */
const PASTED = [/^\s*>/m, /^\s*On\b.*\bwrote:\s*$/im, /^\s*(From|Subject):/im];
/** At most this many characters and lines: a typed ask fits; a long paste is
 * refused, a short one may not be (docs/memos.md). */
export const MAX_REQUEST_CHARS = 600;
export const MAX_REQUEST_LINES = 12;

/** Everything a memo save gets wrong that its input alone shows, checked
 * before any database work, or the evidence it will store. Only the first
 * draft decides the rest: with one (or first_draft_missing), mode is required
 * and request is allowed; without, writing the person gave, neither. With a
 * kept first draft, code lists what changed here, bounded by changeList's own
 * limits. */
export function checkMemo(memo: MemoInput): MemoCheck {
  const refuse = (message: string, field?: "request"): MemoCheck => ({
    ok: false,
    message,
    ...(field ? { field } : {}),
  });
  if (memo.kind_id !== undefined && memo.new_kind !== undefined)
    return refuse("A memo takes kind_id or new_kind, not both.");
  const drafted =
    memo.first_draft !== undefined || memo.first_draft_missing === true;
  if (memo.first_draft !== undefined && memo.first_draft_missing)
    return refuse("Send first_draft or first_draft_missing, not both.");
  if (!drafted) {
    if (memo.request !== undefined)
      return refuse(
        "Writing the person gave you (no first_draft) takes no request.",
        "request",
      );
    return memo.mode !== undefined
      ? refuse(
          "Writing the person gave you (no first_draft) takes no mode; for a draft you wrote, send first_draft, or first_draft_missing if you no longer have it verbatim.",
        )
      : { ok: true };
  }
  if (memo.mode === undefined)
    return refuse("With a first draft, send mode (draft or edit).");
  if (memo.request !== undefined) {
    const request = memo.request;
    const problem = !request
      ? "request is empty"
      : Array.from(request).length > MAX_REQUEST_CHARS
        ? `request is over ${MAX_REQUEST_CHARS} characters`
        : request.split("\n").length > MAX_REQUEST_LINES
          ? `request is over ${MAX_REQUEST_LINES} lines`
          : !request.isWellFormed() || /[^\P{Cc}\n]/u.test(request)
            ? "request holds control characters"
            : PASTED.some((pattern) => pattern.test(request))
              ? 'request looks like quoted or forwarded mail (a line starting >, an "On … wrote:" line or a From or Subject header)'
              : undefined;
    if (problem) return refuse(`${problem}.`, "request");
  }
  if (memo.first_draft === undefined) return { ok: true };
  const list = changeList(memo.first_draft, memo.final);
  return {
    ok: true,
    evidence: {
      state: list.state,
      rows: changeRows(memo.first_draft, memo.final, list),
    },
  };
}

export async function runSave(
  db: StoreDatabase,
  userId: string,
  actor: Actor,
  input: SaveMemoInput,
  /** What checkMemo found for input.memo, before any database work. */
  evidence: Evidence | undefined,
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
  /** The stored outcome; `labelled` for a replay, not for this request's own
   * commit found after a lost acknowledgment. */
  const replay = (existing: Receipt, labelled = true) => {
    if (existing.input_hash !== inputHash)
      throw new StoreError(
        "request_id_reused",
        "This request ID belongs to different input. A changed save needs a new request_id; the original arguments replay the same outcome.",
        409,
      );
    const stored = outcomeSchema.safeParse(existing.result_json);
    // Unreadable only for an outcome stored before memos.
    if (!stored.success) throw unknown();
    // Returned as stored, old fields included (a receipt promises its
    // outcome), with the one label beside it.
    const outcome = existing.result_json as SaveOutcome;
    return labelled ? { ...outcome, replayed: REPLAYED } : outcome;
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
          const save = { tx, userId, actor, input, evidence, result };
          if (input.memo) return await saveMemo(save, input.memo);
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
    return replay(existing, false);
  }
}

type Save = {
  tx: StoreSession;
  userId: string;
  actor: Actor;
  input: SaveMemoInput;
  evidence: Evidence | undefined;
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

/** The one-line receipt the AI repeats: "Kept memo: vendor decline." The
 * label is the memo's kind, or its medium when it has none. */
export const receiptLine = (label: string) => `Kept memo: ${label}.`;

async function saveMemo(save: Save, memo: MemoInput): Promise<SaveOutcome> {
  const { tx, userId, actor, input, evidence, result } = save;
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
  // The same words already on file: a repeated save keeps one memo.
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
  const memoTier = tier({
    state,
    mode: memo.mode,
    firstDraft: memo.first_draft,
    final: memo.final,
  });
  const score =
    memo.first_draft !== undefined
      ? change(memo.first_draft, memo.final)
      : undefined;
  const id = randomUUID();
  // rounds and report_id stay NULL and served_tweak_ids empty (their
  // defaults): this release writes none of them (docs/memos.md).
  await tx.query(sql`INSERT INTO memos(user_id,id,kind_id,medium,summary,audience,purpose,mode,
      first_draft,first_draft_state,final,change,tier,client_json,request_id,
      request,changes_state)
    VALUES (${userId},${id},${kind?.id ?? null},${memo.context.medium},${memo.context.summary},
      ${memo.context.audience ?? null},${memo.context.purpose ?? null},${memo.mode ?? null},
      ${memo.first_draft ?? null},${state},${memo.final},${score ?? null},
      ${memoTier},${client(actor)},${input.request_id},
      ${memo.request ?? null},${evidence?.state ?? null})`);
  // Code's own list, the memo's tweaks: offsets, the cut sides and the
  // format marker; the label, tweak and quote columns stay NULL.
  const rows = evidence?.rows ?? [];
  if (rows.length)
    await tx.query(sql`INSERT INTO memo_changes(user_id,memo_id,n,draft_start,draft_end,final_start,final_end,
        "before","after",truncated,about)
      SELECT ${userId}::text,${id}::text,r.n,r.draft_start,r.draft_end,r.final_start,r.final_end,
        r.before,r.after,r.truncated,r.about
      FROM json_to_recordset(${JSON.stringify(
        rows.map((r) => ({
          n: r.n,
          draft_start: r.draftStart,
          draft_end: r.draftEnd,
          final_start: r.finalStart,
          final_end: r.finalEnd,
          before: r.before,
          after: r.after,
          truncated: r.truncated,
          about: r.about,
        })),
      )}::json) AS r(n smallint,draft_start int,draft_end int,final_start int,final_end int,
        "before" text,"after" text,truncated boolean,about text)`);
  return result("saved", {
    memo: {
      memo_id: id,
      tier: memoTier,
      ...(kind ? { kind_id: kind.id, kind: kind.label } : {}),
      ...(score !== undefined
        ? { change: Math.round(score * 1000) / 1000 }
        : {}),
      ...(evidence
        ? {
            changes: {
              state: evidence.state,
              found: rows.filter((r) => r.about !== "format").length,
            },
          }
        : {}),
    },
    receipt: receiptLine(kind?.label ?? memo.context.medium),
  });
}

/** A memo already on file, as a fresh outcome describes one: never its
 * retired rounds or tweaks, whatever an old row holds. */
async function memoSummary(tx: StoreSession, userId: string, id: string) {
  const [row] = await tx.query<{
    tier: "own" | "steered" | "untouched";
    kind_id: string | null;
    kind: string | null;
    change: number | null;
    changes: { state: "itemized" | "too_large"; found: number } | null;
  }>(sql`SELECT m.tier,m.kind_id,k.label AS kind,m.change,
      CASE WHEN m.changes_state IS NOT NULL THEN (SELECT json_build_object('state',m.changes_state,
        'found',count(*) FILTER (WHERE c.about IS DISTINCT FROM 'format'))
        FROM memo_changes c WHERE c.user_id=m.user_id AND c.memo_id=m.id) END AS changes
    FROM memos m LEFT JOIN memo_kinds k ON k.user_id=m.user_id AND k.id=m.kind_id
    WHERE m.user_id=${userId} AND m.id=${id}`);
  return {
    memo_id: id,
    tier: row!.tier,
    ...(row!.kind_id ? { kind_id: row!.kind_id, kind: row!.kind ?? "" } : {}),
    ...(row!.change !== null
      ? { change: Math.round(row!.change * 1000) / 1000 }
      : {}),
    ...(row!.changes ? { changes: row!.changes } : {}),
  };
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
