import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { headingLine, type CardHead } from "./cards";
import type { SaveMemoInput } from "./compiled";
import {
  databaseFailure,
  type StoreDatabase,
  type StoreSession,
} from "./database";
import { StoreError } from "./errors";
import { exactEditsProposal, exactMoves } from "../exact-edits";
import { MAX_REQUEST_BYTES } from "../http";
import { readLimits, utf8Bytes, type StoreLimits } from "./limits";
import { recordAcceptedChange } from "./provenance";
import { BASELINE, bullet, FILINGS, ruleText, type Documents } from "./reports";
import { applySampleChanges } from "./samples";
import { requireActiveAccount } from "./accounts";
import { hash, readSnapshot, type Snapshot } from "./snapshot";
import { assertTrialAccess } from "./trials";

const retiredSample = z.object({
  id: z.string(),
  reason: z.enum(["replaced", "removed", "evicted"]),
});
const outcomeSchema = z.object({
  status: z.enum(["saved", "unchanged", "conflict", "failed"]),
  request_id: z.string(),
  version: z.string().optional(),
  question: z.string().optional(),
  error: z.string().optional(),
  /** A StoreError's client-facing message; never raw internal text. */
  message: z.string().optional(),
  samples_retired: z.array(retiredSample).optional(),
});
export type SaveOutcome = z.infer<typeof outcomeSchema>;
type Receipt = { input_hash: string; result_json: unknown };
/** The assistant a save is attributed to. */
type Actor = { issuer: string; clientId: string };
/** One save's input, known once it is parsed and the assistant is known. */
type Save = {
  userId: string;
  actor: Actor;
  input: SaveMemoInput;
  result: (
    status: SaveOutcome["status"],
    rest?: Partial<SaveOutcome>,
  ) => SaveOutcome;
};

const nameTheReport = "Name the report and send the rule's text in rules.";

async function receipt(tx: StoreSession, userId: string, id: string) {
  return (
    await tx.query<Receipt>(
      sql`SELECT input_hash,result_json FROM save_requests WHERE user_id=${userId} AND request_id=${id}`,
    )
  )[0];
}

async function checkSize(tx: StoreSession, documents: Documents) {
  // Every source byte is preserved; only headings, when lines, sample context
  // and quoting, and blank lines are added. Each body has its own cap.
  const limits = await readLimits(tx);
  const cap = Math.min(limits.report_body_bytes, 262144);
  if (
    utf8Bytes(documents.cover) > cap ||
    documents.reports.some((r) => utf8Bytes(r.body) > cap) ||
    utf8Bytes(documents.full) > 1572864
  )
    throw new StoreError(
      "tps_body_limit",
      "A report exceeds its size limit. Nothing was truncated or published.",
      422,
    );
}

/** One save, one transaction: replay a known request ID, or check the gates,
 * the version and the size limits, apply and publish every change, and write
 * the receipt with its result. A receipt commits with the changes or not at
 * all, so a stored receipt always holds the outcome. */
/** The refusal for a rule that would be stored with the retired setup prefix. */
export const baselineRefusal = (text: string, report: string) =>
  new StoreError(
    "baseline_unknown",
    `"${describe(text, 120)}" in ${report} starts with "Baseline: ", a prefix only the retired setup picks used. Send the rule in the person's own words without "Baseline: "; an existing Baseline rule can still be retired, or edited to drop the prefix. Nothing was changed.`,
    422,
  );

export async function runSave(
  db: StoreDatabase,
  userId: string,
  actor: Actor,
  input: SaveMemoInput,
  /** Charges the call inside the save's transaction (see below). */
  admit?: (session: StoreSession) => Promise<void>,
): Promise<SaveOutcome> {
  const inputHash = hash(input);
  // Every save is exact: the caller sends the bytes, and no model rewrites them.
  const structured =
    input.rules !== undefined ||
    input.exact_edits !== undefined ||
    input.moves !== undefined ||
    input.sample !== undefined ||
    input.sample_context !== undefined ||
    input.retire_samples !== undefined;
  const result = (
    status: SaveOutcome["status"],
    rest: Partial<SaveOutcome> = {},
  ): SaveOutcome => ({ status, request_id: input.request_id, ...rest });
  const save: Save = { userId, actor, input, result };
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
    // Unreadable only for a claim a revision before 0029 left open (0029
    // deletes those; the same request then runs as a new save) or a retired
    // model-era outcome.
    if (!stored.success) throw unknown();
    return stored.data;
  };
  try {
    return await db.transaction(async (tx) => {
      // Saves take only the account lock; store_config is read unlocked. A
      // concurrent save of the same request waits here, then replays.
      await requireActiveAccount(tx, userId, { lock: true });
      const existing = await receipt(tx, userId, input.request_id);
      if (existing) return replay(existing);
      // After replay, so a receipt from before exact-only saves still recovers.
      if (!structured)
        throw new StoreError("invalid_input", nameTheReport, 400);
      // Account gates answer without a receipt, so the same request can
      // succeed once the gate opens.
      await assertTrialAccess(tx, userId);
      // Charged here, after replay and every gate: the charge commits with the
      // receipt or rolls back with it, so a save that records an outcome
      // (saved, unchanged, conflict or failed) counts once, a replay of it
      // counts nothing, and an over-limit save writes no receipt.
      await admit?.(tx);
      const current = await readSnapshot(tx, userId);
      const decide = async (): Promise<SaveOutcome> => {
        if (input.expected_version !== current.version)
          return result("conflict", { version: current.version });
        const limits = await readLimits(tx);
        if (utf8Bytes(JSON.stringify(input)) > MAX_REQUEST_BYTES)
          return result("failed", {
            error: "request_too_large",
            message: "The save request is too large. Nothing was changed.",
          });
        if (utf8Bytes(input.text) > limits.body_bytes)
          return result("failed", {
            error: "memo_body_limit",
            message: "The submitted memo is too large. Nothing was changed.",
          });
        // A refusal or failure while applying undoes every change it made,
        // and the receipt stores it, so the same request replays it.
        await tx.query(sql`SAVEPOINT apply`);
        try {
          return await applySave(save, tx, current, limits);
        } catch (error) {
          const failure = databaseFailure(error);
          await tx.query(sql`ROLLBACK TO SAVEPOINT apply`);
          // databaseFailure yields only StoreErrors, whose messages are
          // written for clients; unknown errors carry its generic message.
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

type Head = CardHead;

/** A card's description, derived without a model: the first non-blank line,
 * trimmed and cut to fit the byte cap. Descriptions are never printed. */
function describe(body: string, maxBytes: number) {
  const line =
    body
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  if (utf8Bytes(line) <= maxBytes) return line;
  let cut = "";
  for (const char of line) {
    if (utf8Bytes(cut + char + "…") > maxBytes) break;
    cut += char;
  }
  return cut.trimEnd() + "…";
}

/** Validate and apply, inside the save's transaction: resolve the exact edits
 * and moves against the locked snapshot, refuse collisions and limit breaches,
 * then write every card and sample change and publish. */
async function applySave(
  save: Save,
  tx: StoreSession,
  current: Snapshot,
  limits: StoreLimits,
): Promise<SaveOutcome> {
  const { userId, actor, input, result } = save;
  // Every anchor resolves against the locked snapshot.
  const cards = current.active.map((h) => ({
    id: h.id,
    description: h.description,
    text: h.body,
  }));
  const { updates, retire } = exactEditsProposal(
    cards,
    input.exact_edits ?? [],
  );
  const moves = exactMoves(
    cards,
    (input.moves ?? []).map((m) => ({
      before: m.before,
      report: m.report === "doc" ? "document" : m.report,
    })),
  );
  // The active rules as this save leaves them: edits, removals and moves
  // applied. A changed rule may not end up printing identically to another
  // in its report, because neither could then be targeted; an untouched
  // identical pair does not block the save. Rules compare as printed, so a
  // bare rule and its compiler-era "- " twin are the same rule.
  const retiring = new Set(retire);
  const edited = new Map(updates.map((u) => [u.id, u.text]));
  const movedTo = new Map(moves.map((m) => [m.id, m.report]));
  const key = (report: string, body: string) =>
    JSON.stringify([report, bullet(body)]);
  const after = current.active
    .filter((h) => !retiring.has(h.id))
    .map((h) => {
      const report = movedTo.get(h.id) ?? h.report;
      const body = edited.get(h.id) ?? h.body;
      return {
        report,
        body,
        key: key(report, body),
        changed: report !== h.report || body !== h.body,
      };
    });
  const counts = new Map<string, number>();
  for (const card of after)
    counts.set(card.key, (counts.get(card.key) ?? 0) + 1);
  const collision = after.find(
    (card) => card.changed && counts.get(card.key)! > 1,
  );
  if (collision)
    throw new StoreError(
      "edit_conflict",
      `This save would leave two identical rules in ${collision.report === "cover" ? "the cover sheet" : `the ${collision.report} report`}: "${describe(collision.body, 120)}". Change the wording or remove one of them. Nothing was changed.`,
      409,
    );
  // A rule that prints like a rule in the same report after this save, or
  // an earlier entry in this request, is skipped.
  const onFile = new Set(after.map((card) => card.key));
  const creates: { report: (typeof FILINGS)[number]; text: string }[] = [];
  for (const rule of input.rules ?? []) {
    const report = rule.report === "doc" ? "document" : rule.report;
    const printed = key(report, rule.text);
    if (onFile.has(printed)) continue;
    onFile.add(printed);
    creates.push({ report, text: rule.text });
  }
  // Only the retired setup picks filed the "Baseline: " prefix, so no rule
  // gains or keeps it through this save, whether filed new or changed by an
  // exact edit or a move. Retiring one, or removing its prefix, still works.
  const prefixed = [
    ...creates,
    ...after
      .filter((card) => card.changed)
      .map((card) => ({ report: card.report, text: card.body })),
  ].find((rule) => ruleText(rule.text).startsWith(BASELINE));
  if (prefixed !== undefined)
    throw baselineRefusal(prefixed.text, prefixed.report);
  const attribution = JSON.stringify({
    kind: "assistant",
    issuer: actor.issuer,
    client_id: actor.clientId,
  });
  const known = new Map(current.active.map((h) => [h.id, h]));
  // A rule cannot be moved and retired at once, including by an exact
  // edit that empties it.
  if (moves.some((m) => retire.includes(m.id)))
    throw new StoreError(
      "move_conflict",
      "A rule this save removes cannot also move. Nothing was changed.",
      409,
    );
  if (
    [...updates, ...creates].some((m) => utf8Bytes(m.text) > limits.body_bytes)
  )
    throw new StoreError(
      "memo_body_limit",
      "A rule exceeds its size limit. Nothing was changed.",
      422,
    );
  // Milton prints each report's heading; one inside card text would repeat.
  if (
    creates.some((m) => headingLine.test(m.text)) ||
    updates.some(
      (m) => known.get(m.id)?.body !== m.text && headingLine.test(m.text),
    )
  )
    throw new StoreError(
      "card_heading",
      "Instruction text cannot contain Markdown headings; Milton adds each report's heading. Nothing was changed.",
      422,
    );
  // Moving a rule to where it already is changes nothing.
  const moveTo = new Map(
    moves
      .filter((m) => known.get(m.id)!.report !== m.report)
      .map((m) => [m.id, m.report]),
  );
  const samples = await applySampleChanges(
    tx,
    userId,
    input,
    current,
    attribution,
  );
  const unchanged =
    !samples.changed &&
    moveTo.size === 0 &&
    creates.length === 0 &&
    retire.length === 0 &&
    updates.every((m) => known.get(m.id)?.body === m.text);
  if (unchanged) return result("unchanged", { version: current.version });
  const append = async (
    h: Pick<Head, "id" | "version" | "description" | "body" | "report">,
    archived: boolean,
    kind: string,
  ) => {
    await tx.query(sql`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,archived,report,reason,actor_json,details_json)
        VALUES (${userId},${h.id},${h.version + 1},${h.description},${h.body},${archived},${h.report},'Filed memo',${attribution},${JSON.stringify({ kind, request_id: input.request_id })})`);
  };
  // Only explicit targets get new history rows. Omission preserves bytes,
  // descriptions, reports and versions; it never means retirement. A
  // rule both edited and moved gets one version carrying both.
  for (const memo of updates) {
    const old = known.get(memo.id)!;
    if (old.body === memo.text) continue;
    await append(
      {
        ...old,
        body: memo.text,
        report: moveTo.get(memo.id) ?? old.report,
      },
      false,
      "update",
    );
    moveTo.delete(memo.id);
  }
  for (const [id, report] of moveTo)
    await append({ ...known.get(id)!, report }, false, "move");
  for (const memo of creates) {
    const id = randomUUID();
    await tx.query(
      sql`INSERT INTO instruction_cards(user_id,id) VALUES (${userId},${id})`,
    );
    await append(
      {
        id,
        version: 0,
        description: describe(
          memo.text,
          Math.min(limits.description_bytes, 500),
        ),
        body: memo.text,
        report: memo.report,
      },
      false,
      "create",
    );
  }
  for (const id of retire) await append(known.get(id)!, true, "archive");
  return publishSave(save, tx, current, samples.retired, attribution);
}

/** Publish: check the assembled documents against their size limits, record
 * the accepted change and answer with the new version. Nothing is stored
 * beyond the cards and samples; reads assemble the documents. */
async function publishSave(
  save: Save,
  tx: StoreSession,
  before: Snapshot,
  retired: z.infer<typeof retiredSample>[],
  attribution: string,
) {
  const { userId, input, result } = save;
  const updated = await readSnapshot(tx, userId);
  await checkSize(tx, updated.documents);
  await recordAcceptedChange(tx, {
    userId,
    requestId: input.request_id,
    operation: "save_memo",
    request: {
      text: input.text,
      ...(input.rules ? { rules: input.rules } : {}),
      ...(input.exact_edits ? { exact_edits: input.exact_edits } : {}),
      ...(input.moves ? { moves: input.moves } : {}),
      ...(input.sample ? { sample: input.sample } : {}),
      ...(input.sample_context ? { sample_context: input.sample_context } : {}),
      ...(input.retire_samples ? { retire_samples: input.retire_samples } : {}),
    },
    actor: JSON.parse(attribution),
    transformation: { pipeline: "exact:v1" },
    before: before.heads,
    after: updated.heads,
    beforeTps: before.version,
    afterTps: updated.version,
    beforeSource: before.fingerprint,
    afterSource: updated.fingerprint,
  });
  return result("saved", {
    version: updated.version,
    ...(retired.length ? { samples_retired: retired } : {}),
  });
}
