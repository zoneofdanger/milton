import { z } from "zod";
import type { StoreSession } from "./database";
import { StoreError } from "./errors";
import { databaseFailure } from "./database";
import { recordAcceptedChange } from "./provenance";
import {
  outcomeSchema,
  retiredSample,
  type SaveContext,
  type Snapshot,
} from "./save-context";

/** Publish: rebuild and publish the report, record the accepted change, and
 * complete the receipt. */
export async function publishSave(
  ctx: SaveContext,
  tx: StoreSession,
  before: Snapshot,
  retired: z.infer<typeof retiredSample>[],
  attribution: string,
) {
  const { userId, input, result, snapshot, complete, assemble, publish } = ctx;
  const updated = await snapshot(tx);
  const body = await assemble(tx, updated.documents);
  const publishedVersion = await publish(tx, updated, body);
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
      ...(input.retire_samples ? { retire_samples: input.retire_samples } : {}),
    },
    actor: JSON.parse(attribution),
    transformation: { pipeline: "exact:v1" },
    before: before.heads,
    after: updated.heads,
    beforeTps: before.version,
    afterTps: publishedVersion,
    beforeSource: before.fingerprint,
    afterSource: updated.fingerprint,
  });
  return complete(
    tx,
    result("saved", {
      version: publishedVersion,
      ...(retired.length ? { samples_retired: retired } : {}),
    }),
  );
}

/** After a failed validation or apply: a committed result wins; otherwise the
 * claimed receipt completes as failed. */
export function recoverSave(ctx: SaveContext, error: unknown) {
  const { db, input, result, lock, receipt, complete } = ctx;
  const failure = databaseFailure(error);
  // A committed result wins even when the connection failed while returning it.
  return db
    .transaction(async (tx) => {
      await lock(tx);
      const existing = await receipt(tx, input.request_id);
      if (existing?.completed) return outcomeSchema.parse(existing.result_json);
      if (!existing) throw failure;
      // databaseFailure yields only StoreErrors, whose messages are written
      // for clients; unknown errors carry its generic message.
      return complete(
        tx,
        result("failed", {
          error: failure.code,
          message: failure.message,
        }),
      );
    })
    .catch(() => {
      throw new StoreError(
        "save_outcome_unknown",
        "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
        503,
        { request_id: input.request_id },
      );
    });
}
