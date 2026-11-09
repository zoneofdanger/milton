import { sql } from "drizzle-orm";
import { accountUnavailable } from "./accounts";
import type { StoreDatabase } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { assertTrialAccess, type TrialStatus } from "./trials";
import {
  invalidKind,
  kindValid,
  readCoverSheet,
  readReport,
  type ReportIntent,
} from "./memos";
import { memoShapeProblem, runSave, type SaveOutcome } from "./save";
import type { CallUsage } from "./usage";
// The save schema is served to AIs, so it lives with the MCP tools.
import { oneChange, saveMemoInput, type SaveMemoInput } from "../mcp-tools";
export type { SaveMemoInput } from "../mcp-tools";
export type { SaveOutcome } from "./save";

/** One account's memos as an AI reads and saves them. Without `actor` (the
 * web app), reads only. */
export function compiledMemos(
  db: StoreDatabase,
  userId: string,
  actor?: { issuer: string; clientId: string },
  /** Sees the trial status each AI read's or save's gate admitted. */
  gated?: (status: TrialStatus) => void,
  /** Admits the AI call `call` names, after every gate and before the work;
   * it never waits on the database. */
  admit?: (call?: CallUsage) => void,
) {
  /** An AI read passes the trial gate first (whose statement checks the
   * account and the intent's kind, so they refuse before the gate), then is
   * admitted. Reads take no lock. */
  async function gate(call?: CallUsage, kindId?: string) {
    if (actor) {
      const status = await assertTrialAccess(
        db,
        userId,
        kindId
          ? {
              value: sql`CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') THEN 'closed'
                  WHEN ${kindValid(userId, kindId)} THEN 'valid' END`,
              admit(found) {
                if (found === "closed") throw accountUnavailable();
                if (found !== "valid") throw invalidKind();
              },
            }
          : undefined,
      );
      gated?.(status);
    }
    admit?.(call);
  }
  return {
    async readCoverSheet(call?: CallUsage) {
      try {
        await gate(call);
        return await readCoverSheet(db, userId);
      } catch (error) {
        throw databaseFailure(error);
      }
    },
    async readReport(intent: ReportIntent, call?: CallUsage) {
      try {
        await gate(call, intent.kind_id);
        return await readReport(db, userId, intent);
      } catch (error) {
        throw databaseFailure(error);
      }
    },
    async saveMemo(raw: SaveMemoInput, call?: CallUsage): Promise<SaveOutcome> {
      const parsed = saveMemoInput.safeParse(raw);
      if (!parsed.success)
        throw new StoreError(
          "invalid_input",
          parsed.error.issues.find((i) => i.message === oneChange)
            ? oneChange + " Nothing was changed."
            : `create_memo: ${[
                ...new Set(
                  parsed.error.issues.map((i) => i.path.join(".") || i.message),
                ),
              ]
                .slice(0, 5)
                .join(", ")} ${
                parsed.error.issues.length === 1 ? "is" : "are"
              } malformed; see the input schema. Nothing was changed.`,
          400,
        );
      const problem = parsed.data.memo && memoShapeProblem(parsed.data.memo);
      if (problem)
        throw new StoreError(
          "invalid_input",
          `${problem} Nothing was changed.`,
          400,
        );
      if (!actor)
        throw new StoreError(
          "assistant_required",
          "Save memos through your connected AI.",
          403,
        );
      return runSave(
        db,
        userId,
        actor,
        parsed.data,
        () => admit?.(call),
        gated,
      );
    },
  };
}
