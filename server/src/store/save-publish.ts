import { z } from "zod";
import type { StoreSession } from "./database";
import { recordAcceptedChange } from "./provenance";
import { retiredSample, type SaveContext, type Snapshot } from "./save-context";

/** Publish: check the assembled documents against their size limits, record
 * the accepted change and answer with the new version. Nothing is stored
 * beyond the cards and samples; reads assemble the documents. */
export async function publishSave(
  ctx: SaveContext,
  tx: StoreSession,
  before: Snapshot,
  retired: z.infer<typeof retiredSample>[],
  attribution: string,
) {
  const { userId, input, result, snapshot, checkSize } = ctx;
  const updated = await snapshot(tx);
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
