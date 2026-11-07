import {
  assembleExport,
  FILINGS,
  REPORT_IDS,
  type Documents,
  type ReportIntent,
} from "./reports";
import { z } from "zod";
import type { StoreDatabase } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { utf8Bytes } from "./limits";
import { assertTrialAccess } from "./trials";
import { readSnapshot } from "./snapshot";
import { runSave, type SaveOutcome } from "./save";
import { oneLine, sampleContextInput } from "./sample-context";
export { oneLine } from "./sample-context";

const text = z
  .string()
  .max(131072)
  .refine(
    (v) => v.isWellFormed() && !v.includes("\0") && utf8Bytes(v) <= 131072,
  );
const oneKind = "A sample needs kind_id or new_kind, not both.";
const badRules =
  "rules takes 1–100 entries, each with a report (one of the five, doc or cover) and non-blank text. Nothing was changed.";
export const saveMemoInput = z
  .strictObject({
    text: text
      .refine((v) => v.trim().length > 0)
      .describe(
        "What this save does and why, in a sentence. Milton records it with the save and never stores it as a rule.",
      ),
    rules: z
      .array(
        z.strictObject({
          report: z
            .enum([...FILINGS, "doc"])
            .describe(
              "The report the rule belongs to, or cover for a rule true of all writing.",
            ),
          text: text
            .refine((v) => v.trim().length > 0)
            .describe(
              "The rule exactly as the person approved it, with its conditions and exceptions. Milton stores these bytes unchanged.",
            ),
        }),
      )
      .min(1)
      .max(100)
      .optional()
      .describe(
        "New rules, one entry each. A rule already on file in that report with the same text is skipped.",
      ),
    exact_edits: z
      .array(
        z.strictObject({
          before: text.min(1),
          after: text,
        }),
      )
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Corrections and removals of existing rules, sent as Corrections in the server instructions says. All edits use the original snapshot. Preserve complete conditions, subjects and scope.",
      ),
    moves: z
      .array(
        z.strictObject({
          before: text.min(1),
          report: z.enum([...FILINGS, "doc"]),
        }),
      )
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Optional moves of existing rules, only when the person asks to change where a rule applies. before is copied verbatim from the rule and occurs exactly once across all rules; report is the destination report, or cover for the cover sheet. The rule keeps its exact text.",
      ),
    sample: z
      .strictObject({
        report: z
          .enum([...REPORT_IDS, "doc"])
          .describe("The report this writing belongs to."),
        kind_id: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "The kind_id of an existing kind in this report, from get_report samples. Reuse one whenever it fits.",
          ),
        new_kind: oneLine(60)
          .optional()
          .describe(
            "Only when no listed kind fits: a label of one or two words, such as follow-up email. A label already used in this report, in any letter case, files under that kind. Send kind_id or new_kind, not both.",
          ),
        sample_id: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "Stable id of an active sample the person approved revising. Omit for a new example; include complete approved text, context and classification.",
          ),
        context: sampleContextInput,
        text: text
          .refine((v) => v.trim().length > 0)
          .describe(
            "The approved writing exactly as the person approved it. Milton stores it unchanged.",
          ),
      })
      .refine((v) => (v.kind_id === undefined) !== (v.new_kind === undefined), {
        message: oneKind,
      })
      .optional()
      .describe(
        "Optional approved sample to file under a report, offered once when the person approves a draft and sent only after they say yes. Every approved sample stays; a report read serves the eight that best fit its intent. Use sample_id to append a complete revision, or retire_samples to remove an example. Only retirement is reported in samples_retired. A new example identical in body, report/kind and complete context files nothing; revisions never merge identities.",
      ),
    sample_context: z
      .strictObject({
        report: z.enum([...REPORT_IDS, "doc"]),
        sample_id: z.string().min(1).max(256),
        kind_id: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "Optional existing kind in the same report; omit to preserve classification.",
          ),
        context: sampleContextInput,
      })
      .optional()
      .describe(
        "Correct an active sample after approval of the complete replacement context and classification. Omitted optional context fields are deliberately cleared. Appends a complete revision with unchanged body and stable id; the approval date and recency advance. Reclassification preserves separate identities even when their text matches. Cannot combine with sample or retire_samples. An identical replacement is unchanged.",
      ),
    retire_samples: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Optional ids of active samples the person asked to remove, from get_report samples.",
      ),
    request_id: z
      .uuid()
      .describe(
        "A new UUID for a new logical save. Reuse this UUID and the exact original arguments only to recover that request's uncertain outcome.",
      ),
    expected_version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe(
        "Copy the opaque version from the latest get_cover_sheet or get_report result. Never invent a version.",
      ),
  })
  .refine(
    (v) =>
      v.sample_context === undefined ||
      (v.sample === undefined && v.retire_samples === undefined),
    {
      message: "sample_context cannot combine with sample or retire_samples.",
    },
  );
export type SaveMemoInput = z.infer<typeof saveMemoInput>;
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
