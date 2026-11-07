import { assembleExport, type Documents, type ReportIntent } from "./reports";
import type { StoreDatabase } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { assertTrialAccess } from "./trials";
import { readSnapshot } from "./snapshot";
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
) {
  /** A read assembles the documents from cards and samples. It takes no lock
   * and writes nothing: one statement for the snapshot, then the trial gate
   * for an assistant. The size cap bounds saves; a read serves what is on file. */
  async function read(intent?: ReportIntent, includeGuides = false) {
    try {
      const current = await readSnapshot(db, userId, intent, includeGuides);
      if (actor) await assertTrialAccess(db, userId);
      return current;
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
      return runSave(db, userId, actor, parsed.data);
    },
  };
}
