// The tool contract served to assistants beside mcp.ts: every input schema,
// the read envelopes and refusals, and the tool runner over a TenantStore.
import { z } from "zod";
import type { TenantStore } from "./store";
import { StoreError } from "./store/errors";
import { utf8Bytes } from "./store/limits";
import { subscriptionRequired } from "./store/trials";
import {
  FILINGS,
  REPORT_IDS,
  resolveReportId,
  type Documents,
  type ReportDocument,
} from "./store/reports";
import {
  contextDimensions,
  oneLine,
  sampleContextInput,
} from "./store/sample-context";
import { reportSetup, setupHint } from "./store/setup";

export const coverSheetInput = z.strictObject({});
export const intentInput = z
  .strictObject({
    situation: oneLine(200).describe(
      'One line on what you are writing, to whom and why, such as "declining a client\'s request for a discount". When not drafting, why you are reading, such as "confirming what is on file".',
    ),
    kind_id: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "An existing personal kind from get_report.kinds, which lists every kind with an active sample in this report regardless of intent or sample selection. Prefer it and fill sparse matches with broader examples; invalid or foreign ids are refused. Never create a kind on read.",
      ),
    context: contextDimensions
      .optional()
      .describe(
        "Relevant known purposes, medium, audience, interaction, whole/excerpt scope and language, using the same dimensions as sample context.",
      ),
  })
  .describe(
    "What the read is for. The report serves the eight samples that best fit it.",
  );
export const reportInput = z.strictObject({
  report_id: z
    .enum([...REPORT_IDS, "doc"])
    .describe(
      "email, chat, post, document (doc is accepted), or speech: the writing situation the task matches.",
    ),
  intent: intentInput,
});
/** The refusal for a get_report call with no intent, as from a client still
 * holding the schema before intent existed. */
export const missingIntent =
  'get_report needs intent: situation, one line on what you are writing, to whom and why (or why you are reading, such as "confirming what is on file"), plus kind_id and relevant context when known; reconnect your assistant if it has no intent field. Nothing was read.';
/** The refusal for a get_report intent that is present but malformed: each
 * limit it broke, and no reconnect hint, since the client has the field. */
export function malformedIntent(intent: unknown) {
  const issues = intentInput.safeParse(intent).error?.issues ?? [];
  const broken = new Set(
    issues.map((issue) =>
      issue.path[0] === "situation"
        ? "situation must be one line of at most 200 characters"
        : "intent takes situation, optional kind_id and bounded context dimensions",
    ),
  );
  return `get_report intent: ${[...broken].join("; ")}. Nothing was read.`;
}
export const listReportsInput = z.strictObject({});

const text = z
  .string()
  .max(131072)
  .refine(
    (v) => v.isWellFormed() && !v.includes("\0") && utf8Bytes(v) <= 131072,
  );
export const oneKind = "A sample needs kind_id or new_kind, not both.";
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

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

export function storeResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  };
}
/** The cover sheet envelope: rules true of all writing, the version every save
 * fences on, and the fixed index. `is_empty` means the whole account is empty.
 * While the account has no guidance, `setup` offers sample-first onboarding. */
export function coverSheet(documents: Documents & { version: string }) {
  return {
    text: documents.cover,
    version: documents.version,
    is_empty: documents.is_empty,
    reports: documents.index,
    ...(documents.is_empty ? { setup: reportSetup(documents, "email") } : {}),
  };
}
/** Served samples without their bodies (those stay in text), in served order, so
 * an assistant can name a sample to revise or remove and read its approved
 * context and match evidence. */
const sampleIndex = (report: ReportDocument) =>
  report.samples.map((s) => ({
    id: s.id,
    kind_id: s.kind_id,
    kind: s.kind,
    context: s.context,
    date: s.date,
    revision: s.revision,
    ...(s.match ? { match: s.match } : {}),
  }));
/** Optional setup, served only while a report has no rules or samples. */
const setupField = (documents: Documents, id: (typeof REPORT_IDS)[number]) => {
  const setup = reportSetup(documents, id);
  return setup === undefined ? {} : { setup };
};
export const reportEnvelope = (
  documents: Documents & { version: string },
  id: (typeof REPORT_IDS)[number],
) => {
  const report = documents.reports.find((r) => r.id === id)!;
  return {
    report_id: id,
    text: report.body,
    ...(report.guide ? { guide: report.guide } : {}),
    version: documents.version,
    is_empty: report.is_empty,
    kinds: report.kinds,
    samples: sampleIndex(report),
    selection:
      "Up to eight: requested kind, purpose overlap, matching context dimensions, situation text, then newest. Sparse matches include broader examples; match lists exact signals. Unknown scope stays unknown; excerpts do not establish whole-work structure.",
    ...setupField(documents, id),
  };
};
export const reportList = (documents: Documents & { version: string }) => ({
  reports: documents.reports.map((r) => ({
    report_id: r.id,
    text: r.body,
    ...(r.guide ? { guide: r.guide } : {}),
    is_empty: r.is_empty,
    samples: sampleIndex(r),
    // A one-line pointer, so the list stays small; get_report serves the block.
    ...(r.is_empty ? { setup: setupHint(r.id) } : {}),
  })),
  version: documents.version,
});

export function createStoreMemoTools(
  store: TenantStore,
  options: { readOnly?: boolean } = {},
) {
  function permission<T extends { setup?: unknown }>(value: T) {
    if (!options.readOnly) return value;
    const { setup: _setup, ...read } = value;
    return {
      ...read,
      permission:
        "Read only. To save approved writing guidance, reconnect with Read and write.",
    };
  }
  async function withNotice<T extends object>(value: T) {
    // A failed claim must never turn an accepted save into an apparent failure.
    // Claiming means offered in one response, not displayed/acknowledged by a user,
    // so a committed claim is always awaited and returned; the claim transaction's
    // own lock and statement timeouts bound how long it can take.
    try {
      const notice = await store.trialNotice?.();
      return notice ? { ...value, notice } : value;
    } catch {
      return value;
    }
  }
  async function run(operation: () => Promise<ToolResult>) {
    try {
      return await operation();
    } catch (thrown) {
      const error =
        thrown instanceof StoreError && thrown.code === "subscription_required"
          ? subscriptionRequired(store.appOrigin)
          : thrown;
      // The over-limit refusal carries its limit and reset time, no prose.
      if (error instanceof StoreError && error.code === "rate_limited")
        return storeResult({ error: error.code, ...error.details }, true);
      return storeResult(
        {
          ...(error instanceof StoreError ? error.details : {}),
          error: error instanceof StoreError ? error.code : "store_unavailable",
          message:
            error instanceof StoreError
              ? error.message
              : "Milton is unavailable. No save outcome is confirmed.",
        },
        true,
      );
    }
  }
  return {
    get_cover_sheet: () =>
      run(async () =>
        storeResult(
          await withNotice(permission(coverSheet(await store.readDocuments()))),
        ),
      ),
    get_report: (input: z.infer<typeof reportInput>) =>
      run(async () => {
        const report = resolveReportId(input.report_id)!;
        return storeResult(
          await withNotice(
            permission(
              reportEnvelope(
                await store.readDocuments({ ...input.intent, report }),
                report,
              ),
            ),
          ),
        );
      }),
    list_reports: () =>
      run(async () => {
        const list = reportList(await store.readDocuments());
        return storeResult(
          await withNotice(
            options.readOnly
              ? { ...list, reports: list.reports.map(permission) }
              : list,
          ),
        );
      }),
    create_memo: (input: SaveMemoInput) =>
      run(async () => {
        if (options.readOnly)
          return storeResult(
            {
              error: "insufficient_scope",
              message:
                "This connection is read only. Reconnect with Read and write to save approved guidance.",
            },
            true,
          );
        const outcome = await store.saveMemo(input);
        if (outcome.error === "subscription_required") {
          const error = subscriptionRequired(store.appOrigin);
          return storeResult(
            { ...outcome, ...error.details, message: error.message },
            true,
          );
        }
        return storeResult(
          outcome.status === "saved" || outcome.status === "unchanged"
            ? await withNotice(outcome)
            : outcome,
          outcome.status === "failed" || outcome.status === "conflict",
        );
      }),
  };
}
