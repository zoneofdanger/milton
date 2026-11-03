import { sql } from "drizzle-orm";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { readLimits, utf8Bytes } from "./index";
import { MAX_REQUEST_BYTES } from "../http";
import { assertTrialAccess } from "./trials";
import { lockSpendPolicy } from "./spend-policy";
import { admitMemoUpdate, claimClock, withMemoUpdate } from "./memo-updates";
import { outcomeSchema, type SaveContext } from "./save-context";

const nameTheReport = "Name the report and send the rule's text in rules.";
const deadlineSeconds = 40;

/** Claim and reserve: replay a known request ID, or check the version and size
 * limits, admit the memo update and write the save receipt. */
export async function claimSave(ctx: SaveContext, structured: boolean) {
  const {
    db,
    userId,
    appOrigin,
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
      // One short shared lock for memo-update admission, then the account lock.
      const policy = await lockSpendPolicy(tx);
      await lock(tx);
      const existing = await receipt(tx, input.request_id);
      if (existing) {
        if (existing.input_hash !== inputHash)
          throw new StoreError(
            "request_id_reused",
            "This request ID belongs to different input. Reuse the exact original request to recover its result.",
            409,
          );
        if (existing.completed)
          return {
            outcome: withMemoUpdate(
              outcomeSchema.parse(existing.result_json),
              existing,
              true,
            ),
          };
        if (existing.live)
          return {
            outcome: withMemoUpdate(result("in_progress"), existing, true),
          };
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
      await assertTrialAccess(tx, userId, appOrigin);
      const current = await snapshot(tx);
      if (input.expected_version !== current.version)
        return {
          outcome: result("conflict", { version: current.version }),
        };
      const limits = await readLimits(tx);
      if (utf8Bytes(JSON.stringify(input)) > MAX_REQUEST_BYTES)
        throw new StoreError(
          "request_too_large",
          "The save request is too large.",
          413,
        );
      if (utf8Bytes(input.text) > limits.body_bytes)
        throw new StoreError(
          "memo_body_limit",
          "The submitted memo is too large.",
          422,
        );
      const clock = await claimClock(tx);
      const updateDay = await admitMemoUpdate(tx, userId, policy, clock);
      await tx.query(sql`INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,reserved_micros,deadline,claimed_at,created_at,memo_update_day,memo_update_state)
      VALUES (${userId},${input.request_id},${inputHash},${current.fingerprint},0,${clock.at}::timestamptz+${deadlineSeconds}*interval '1 second',${clock.at}::timestamptz,${clock.at}::timestamptz,${updateDay}::date,${updateDay ? "held" : "none"})`);
      return { current };
    })
    .catch(async (error) => {
      const failure = databaseFailure(error);
      if (failure.code !== "store_unavailable") throw failure;
      // A claim may have committed without its acknowledgment. Never dispatch
      // from an uncertain claim or release a live hold on a failed lookup.
      try {
        return await db.transaction(async (tx) => {
          await lock(tx);
          const existing = await receipt(tx, input.request_id);
          if (existing && existing.input_hash !== inputHash)
            throw new StoreError(
              "request_id_reused",
              "This request ID belongs to different input.",
              409,
            );
          if (existing?.completed)
            return {
              outcome: withMemoUpdate(
                outcomeSchema.parse(existing.result_json),
                existing,
                true,
              ),
            };
          if (existing?.live)
            return {
              outcome: withMemoUpdate(result("in_progress"), existing, true),
            };
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
