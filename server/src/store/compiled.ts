import { sql } from "drizzle-orm";
import { accountUnavailable } from "./accounts";
import { assembleExport, type Documents, type ReportIntent } from "./reports";
import type { StoreDatabase } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { assertTrialAccess, type TrialStatus } from "./trials";
import { invalidKind, kindValid, readSnapshot } from "./snapshot";
import { runSave, type SaveOutcome } from "./save";
import type { CallUsage } from "./usage";
// The save schema is served to assistants, so it lives with the MCP tools.
import { oneKind, saveMemoInput, type SaveMemoInput } from "../mcp-tools";
export type { SaveMemoInput } from "../mcp-tools";

const badRules =
  "rules takes 1–100 entries, each with a report (one of the five, doc or cover) and non-blank text. Nothing was changed.";
export type CompiledReport = {
  text: string;
  version: string;
  is_empty: boolean;
};
export type { Documents, ReportDocument } from "./reports";
export type { SaveOutcome } from "./save";

export function compiledMemos(
  db: StoreDatabase,
  userId: string,
  actor?: { issuer: string; clientId: string },
  /** Sees the trial status each assistant read's gate admitted. */
  gated?: (status: TrialStatus) => void,
  /** Admits the assistant call `call` names, after every gate and before the
   * work; it never waits on the database. */
  admit?: (call?: CallUsage) => void,
) {
  /** A read assembles the documents from cards and samples. It takes no lock
   * and writes only its usage row, on its own connection: for an assistant the trial gate (whose statement first
   * checks the account and the intent's kind, so they refuse before the gate,
   * as on the snapshot), then one statement for the snapshot. The size cap
   * bounds saves; a read serves what is on file. */
  async function read(
    intent?: ReportIntent,
    includeGuides = false,
    call?: CallUsage,
  ) {
    try {
      if (actor) {
        // As the snapshot orders them: the account, then the kind.
        const status = await assertTrialAccess(
          db,
          userId,
          intent?.kind_id
            ? {
                value: sql`CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') THEN 'closed'
                  WHEN ${kindValid(userId, intent)} THEN 'valid' END`,
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
      return await readSnapshot(db, userId, intent, includeGuides);
    } catch (error) {
      throw databaseFailure(error);
    }
  }
  return {
    /** The cover sheet and the five reports at one version. With an intent,
     * that report serves the eight samples ranked for it; the version stays
     * the same for every intent. */
    async readDocuments(
      intent?: ReportIntent,
      call?: CallUsage,
    ): Promise<Documents & { version: string }> {
      const current = await read(intent, true, call);
      return {
        ...(current.served ?? current.documents),
        reports: (current.served ?? current.documents).reports.map((r) => ({
          ...r,
          ...(current.guides[r.id] ? { guide: current.guides[r.id] } : {}),
        })),
        version: current.version,
      };
    },
    async getTpsReport(): Promise<CompiledReport> {
      const current = await read();
      return {
        text: current.documents.full,
        version: current.version,
        is_empty: current.documents.is_empty,
      };
    },
    async exportTpsReport(): Promise<string> {
      const current = await read();
      return assembleExport(current.active, current.samples);
    },
    async saveMemo(raw: SaveMemoInput, call?: CallUsage): Promise<SaveOutcome> {
      const parsed = saveMemoInput.safeParse(raw);
      if (!parsed.success)
        throw new StoreError(
          "invalid_input",
          parsed.error.issues.some((i) => i.message === oneKind)
            ? oneKind + " Nothing was changed."
            : parsed.error.issues.some((i) => i.path[0] === "rules")
              ? badRules
              : "Supply text stating the purpose, a request UUID, the report version and well-formed change fields. Nothing was changed.",
          400,
        );
      if (!actor)
        throw new StoreError(
          "assistant_required",
          "Save memos through your connected assistant.",
          403,
        );
      return runSave(db, userId, actor, parsed.data, () => admit?.(call));
    },
  };
}
