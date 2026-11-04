import { z } from "zod";
import { StoreError, type TenantStore } from "./index";
import { oneLine, type SaveMemoInput } from "./compiled";
import { subscriptionRequired } from "./trials";
import {
  AUDIENCES,
  PURPOSES,
  REPORT_IDS,
  resolveReportId,
  type Documents,
  type ReportDocument,
} from "./reports";
import { noRules, reportSetup, setupHint } from "./setup";

export const coverSheetInput = z.strictObject({});
export const intentInput = z
  .strictObject({
    situation: oneLine(200).describe(
      'One line on what you are writing, to whom and why, such as "declining a client\'s request for a discount". When not drafting, why you are reading, such as "confirming what is on file".',
    ),
    audience: z
      .enum(AUDIENCES)
      .optional()
      .describe("Who will read it, when you know."),
    purpose: z
      .enum(PURPOSES)
      .optional()
      .describe("What it must do, when you know."),
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
  'get_report needs intent: situation, one line on what you are writing, to whom and why (or why you are reading, such as "confirming what is on file"), plus audience and purpose from their lists when you know them; reconnect your assistant if it has no intent field. Nothing was read.';
/** The refusal for a get_report intent that is present but malformed: each
 * limit it broke, and no reconnect hint, since the client has the field. */
export function malformedIntent(intent: unknown) {
  const issues = intentInput.safeParse(intent).error?.issues ?? [];
  const broken = new Set(
    issues.map((issue) =>
      issue.path[0] === "situation"
        ? "situation must be one line of at most 200 characters"
        : issue.path[0] === "audience"
          ? `audience must be one of ${AUDIENCES.join(", ")}`
          : issue.path[0] === "purpose"
            ? `purpose must be one of ${PURPOSES.join(", ")}`
            : "intent takes only situation, audience and purpose",
    ),
  );
  return `get_report intent: ${[...broken].join("; ")}. Nothing was read.`;
}
export const listReportsInput = z.strictObject({});

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
 * While no rules exist anywhere (samples do not count), `setup` carries the
 * first setup: the opening lines and email's block with the cover questions. */
export function coverSheet(documents: Documents & { version: string }) {
  return {
    text: documents.cover,
    version: documents.version,
    is_empty: documents.is_empty,
    reports: documents.index,
    ...(noRules(documents) ? { setup: reportSetup(documents, "email") } : {}),
  };
}
/** Served samples without their bodies (those stay in text), in served order, so
 * an assistant can reuse a kind or name a sample to replace or remove. Labels
 * appear only when the sample has them. */
const sampleIndex = (report: ReportDocument) =>
  report.samples.map((s) => ({
    id: s.id,
    kind_id: s.kind_id,
    kind: s.kind,
    context: s.context,
    date: s.date,
    ...(s.audience ? { audience: s.audience } : {}),
    ...(s.purpose ? { purpose: s.purpose } : {}),
    ...(s.register ? { register: s.register } : {}),
  }));
/** A report's setup block, served only while that report has no rules. */
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
    version: documents.version,
    is_empty: report.is_empty,
    samples: sampleIndex(report),
    ...setupField(documents, id),
  };
};
export const reportList = (documents: Documents & { version: string }) => ({
  reports: documents.reports.map((r) => ({
    report_id: r.id,
    text: r.body,
    is_empty: r.is_empty,
    samples: sampleIndex(r),
    // A one-line pointer, so the list stays small; get_report serves the block.
    ...(r.rules.length === 0 ? { setup: setupHint(r.id) } : {}),
  })),
  version: documents.version,
});

export function createStoreMemoTools(store: TenantStore) {
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
        storeResult(await withNotice(coverSheet(await store.readDocuments()))),
      ),
    get_report: (input: z.infer<typeof reportInput>) =>
      run(async () => {
        const report = resolveReportId(input.report_id)!;
        return storeResult(
          await withNotice(
            reportEnvelope(
              await store.readDocuments({ ...input.intent, report }),
              report,
            ),
          ),
        );
      }),
    list_reports: () =>
      run(async () =>
        storeResult(await withNotice(reportList(await store.readDocuments()))),
      ),
    create_memo: (input: SaveMemoInput) =>
      run(async () => {
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
