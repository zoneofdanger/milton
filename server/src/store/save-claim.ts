import { sql } from "drizzle-orm";
import { databaseFailure, type StoreSession } from "./database";
import { StoreError } from "./errors";
import { readLimits, utf8Bytes } from "./index";
import { MAX_REQUEST_BYTES } from "../http";
import { assertTrialAccess } from "./trials";
import {
  outcomeSchema,
  type SaveContext,
  type SaveOutcome,
} from "./save-context";

const nameTheReport = "Name the report and send the rule's text in rules.";
const deadlineSeconds = 40;

// Call only after the account lock. A materialized expression evaluates the DB clock once.
async function claimClock(tx: StoreSession): Promise<string> {
  return (
    await tx.query<{
      at: string;
    }>(sql`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM stamp`)
  )[0]!.at;
}

/** Claim and reserve: replay a known request ID, or check the version and size
 * limits and write the save receipt. */
export async function claimSave(ctx: SaveContext, structured: boolean) {
  const {
    db,
    userId,
    input,
    inputHash,
    result,
    lock,
    snapshot,
    receipt,
    complete,
  } = ctx;
  const claim = await db
    .transaction(async (tx) => {
      // Saves take only the account lock; store_config is read unlocked.
      await lock(tx);
      const existing = await receipt(tx, input.request_id);
      if (existing) {
        if (existing.input_hash !== inputHash)
          throw new StoreError(
            "request_id_reused",
            "This request ID belongs to different input. A changed save needs a new request_id; the original arguments replay the same outcome.",
            409,
          );
        if (existing.completed)
          return {
            outcome: outcomeSchema.parse(existing.result_json),
          };
        if (existing.live) return { outcome: result("in_progress") };
        return {
          outcome: await complete(
            tx,
            result("failed", { error: "request_expired" }),
          ),
        };
      }
      // After replay, so a receipt from before exact-only saves still recovers.
      if (!structured)
        throw new StoreError("invalid_input", nameTheReport, 400);
      // Account gates answer without a receipt, so the same request can
      // succeed once the gate opens.
      await assertTrialAccess(tx, userId);
      const current = await snapshot(tx);
      const at = await claimClock(tx);
      const claimReceipt = async () => {
        await tx.query(sql`INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,deadline,claimed_at,created_at)
        VALUES (${userId},${input.request_id},${inputHash},${current.fingerprint},${at}::timestamptz+${deadlineSeconds}*interval '1 second',${at}::timestamptz,${at}::timestamptz)`);
      };
      // A conflict or refusal decided against the request completes a receipt
      // here as in the apply phase: the same request replays the same outcome.
      const decided = async (outcome: SaveOutcome) => {
        await claimReceipt();
        return { outcome: await complete(tx, outcome) };
      };
      if (input.expected_version !== current.version)
        return decided(result("conflict", { version: current.version }));
      const limits = await readLimits(tx);
      if (utf8Bytes(JSON.stringify(input)) > MAX_REQUEST_BYTES)
        return decided(
          result("failed", {
            error: "request_too_large",
            message: "The save request is too large. Nothing was changed.",
          }),
        );
      if (utf8Bytes(input.text) > limits.body_bytes)
        return decided(
          result("failed", {
            error: "memo_body_limit",
            message: "The submitted memo is too large. Nothing was changed.",
          }),
        );
      await claimReceipt();
      return { current };
    })
    .catch(async (error) => {
      const failure = databaseFailure(error);
      if (failure.code !== "store_unavailable") throw failure;
      // A claim may have committed without its acknowledgment. Never dispatch
      // from an uncertain claim or fail a live one on a failed lookup.
      try {
        return await db.transaction(async (tx) => {
          await lock(tx);
          const existing = await receipt(tx, input.request_id);
          if (existing && existing.input_hash !== inputHash)
            throw new StoreError(
              "request_id_reused",
              "This request ID belongs to different input. A changed save needs a new request_id; the original arguments replay the same outcome.",
              409,
            );
          if (existing?.completed)
            return { outcome: outcomeSchema.parse(existing.result_json) };
          if (existing?.live) return { outcome: result("in_progress") };
          if (existing)
            return {
              outcome: await complete(
                tx,
                result("failed", { error: "request_expired" }),
              ),
            };
        });
      } catch (recoveryError) {
        if (
          recoveryError instanceof StoreError &&
          recoveryError.code === "request_id_reused"
        )
          throw recoveryError;
      }
      throw new StoreError(
        "save_outcome_unknown",
        "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
        503,
        { request_id: input.request_id },
      );
    });
  if (!claim)
    throw new StoreError(
      "save_outcome_unknown",
      "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
      503,
      { request_id: input.request_id },
    );
  return claim;
}
