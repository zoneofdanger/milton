import { sql } from "drizzle-orm";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { readLimits, utf8Bytes } from "./index";
import { MAX_REQUEST_BYTES } from "../http";
import { assertTrialAccess } from "./trials";
import { applySave } from "./save-apply";
import {
  outcomeSchema,
  type Receipt,
  type SaveContext,
  type SaveOutcome,
} from "./save-context";

const nameTheReport = "Name the report and send the rule's text in rules.";

/** One save, one transaction: replay a known request ID, or check the gates,
 * the version and the size limits, apply and publish every change, and write
 * the receipt with its result. A receipt commits with the changes or not at
 * all, so a stored receipt always holds the outcome. */
export async function runSave(
  ctx: SaveContext,
  structured: boolean,
): Promise<SaveOutcome> {
  const { db, userId, input, inputHash, result, lock, snapshot, receipt } = ctx;
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
      await lock(tx);
      const existing = await receipt(tx, input.request_id);
      if (existing) return replay(existing);
      // After replay, so a receipt from before exact-only saves still recovers.
      if (!structured)
        throw new StoreError("invalid_input", nameTheReport, 400);
      // Account gates answer without a receipt, so the same request can
      // succeed once the gate opens.
      await assertTrialAccess(tx, userId);
      const current = await snapshot(tx);
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
          return await applySave(ctx, tx, current, limits);
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
      await tx.query(sql`INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,result_json)
        VALUES (${userId},${input.request_id},${inputHash},${current.fingerprint},${JSON.stringify(outcome)}::jsonb)`);
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
        await lock(tx);
        return receipt(tx, input.request_id);
      });
    } catch {
      throw unknown();
    }
    if (!existing) throw failure;
    return replay(existing);
  }
}
