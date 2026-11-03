import { z } from "zod";
import type { ToolResult } from "../tools";
import { StoreError, type TenantStore } from "./index";
import type { SaveMemoInput } from "./compiled";
import { subscriptionRequired } from "./trials";
import { advisory } from "./memo-updates";
import {
  REPORT_IDS,
  resolveReportId,
  type Documents,
  type ReportDocument,
} from "./reports";
import { noRules, reportSetup, setupHint } from "./setup";

export const coverSheetInput = z.strictObject({});
export const reportInput = z.strictObject({
  report_id: z
    .enum([...REPORT_IDS, "doc"])
    .describe(
      "email, chat, post, document (doc is accepted), or speech: the writing situation the task matches.",
    ),
});
export const listReportsInput = z.strictObject({});

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
/** Active samples without their bodies (those stay in text), newest first, so
 * an assistant can reuse a kind or name a sample to replace or remove. */
const sampleIndex = (report: ReportDocument) =>
  report.samples.map((s) => ({
    id: s.id,
    kind_id: s.kind_id,
    kind: s.kind,
    context: s.context,
    date: s.date,
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
      const result = await operation();
      return (
        (await advisory(async () => {
          const balance = await store.memoUpdates?.();
          if (balance && result.content[0]?.type === "text") {
            const value: unknown = JSON.parse(result.content[0].text);
            if (
              typeof value === "object" &&
              value !== null &&
              !Array.isArray(value)
            )
              return storeResult(
                { ...value, memo_updates: balance },
                result.isError,
              );
          }
        })) ?? result
      );
    } catch (error) {
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
      run(async () =>
        storeResult(
          await withNotice(
            reportEnvelope(
              await store.readDocuments(),
              resolveReportId(input.report_id)!,
            ),
          ),
        ),
      ),
    list_reports: () =>
      run(async () =>
        storeResult(await withNotice(reportList(await store.readDocuments()))),
      ),
    create_memo: (input: SaveMemoInput) =>
      run(async () => {
        const outcome = await store.saveMemo(input);
        if (outcome.error === "subscription_required") {
          const error = subscriptionRequired();
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
