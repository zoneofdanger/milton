import { sql } from "drizzle-orm";
import { accountUnavailable } from "./accounts";
import { assembleExport, type Documents, type ReportIntent } from "./reports";
import type { StoreDatabase, StoreSession } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { assertTrialAccess, type TrialStatus } from "./trials";
import { invalidKind, kindValid, readSnapshot } from "./snapshot";
import { runSave, type SaveOutcome } from "./save";
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
  /** Charges an admitted assistant call, on the given session, or refuses it;
   * runs after every gate and before the work. */
  admit?: (session: StoreSession) => Promise<void>,
) {
  /** A read assembles the documents from cards and samples. It takes no lock
   * and writes only its charge: for an assistant the trial gate (whose
   * statement first checks the account and the intent's kind, so they refuse
   * before the gate, as on the snapshot), then the charge, then one statement for the snapshot. The size cap
   * bounds saves; a read serves what is on file. */
  async function read(intent?: ReportIntent, includeGuides = false) {
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
      await admit?.(db);
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
    ): Promise<Documents & { version: string }> {
      const current = await read(intent, true);
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
    async saveMemo(raw: SaveMemoInput): Promise<SaveOutcome> {
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
      return runSave(db, userId, actor, parsed.data, admit);
    },
  };
}
