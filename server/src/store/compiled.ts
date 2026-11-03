import { cardHeads, cardFingerprint } from "./cards";
import {
  assembleDocuments,
  FILINGS,
  REPORT_IDS,
  type Documents,
  type Sample,
} from "./reports";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { StoreDatabase, StoreSession } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { readLimits, utf8Bytes } from "./index";
import { assertTrialAccess } from "./trials";
import {
  memoUpdates,
  withMemoUpdate,
  type UpdateReceipt,
} from "./memo-updates";
import type { Receipt, Report, SaveContext, SaveOutcome } from "./save-context";
import { claimSave } from "./save-claim";
import { applySave } from "./save-apply";
import { recoverSave } from "./save-publish";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = z
  .string()
  .max(32768)
  .refine(
    (v) => v.isWellFormed() && !v.includes("\0") && utf8Bytes(v) <= 32768,
  );
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => v.isWellFormed() && !/[\r\n\0]/.test(v));
const oneKind = "A sample needs kind_id or new_kind, not both.";
const badRules =
  "rules takes 1–20 entries, each with a report (one of the five, doc or cover) and non-blank text. Nothing was changed.";
export const saveMemoInput = z.strictObject({
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
    .max(20)
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
    .max(100)
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
    .max(100)
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
      replaces: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          "The id of an active sample of the same kind that the person asked to replace.",
        ),
      context: oneLine(200).describe(
        "One line of context shown above the sample, such as follow-up after someone agreed to a call.",
      ),
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
      "Optional approved sample to file under a report, offered once when the person approves a draft and sent only after they say yes. At most two stay per kind; Milton retires the oldest beyond that and reports it in samples_retired. Text identical to an active sample of the kind files nothing.",
    ),
  retire_samples: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(100)
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
});
export type SaveMemoInput = z.infer<typeof saveMemoInput>;
export type CompiledReport = {
  text: string;
  version: string;
  is_empty: boolean;
};
export type { Documents, ReportDocument } from "./reports";
export type { SaveOutcome } from "./save-context";

export function compiledMemos(
  db: StoreDatabase,
  userId: string,
  actor?: { issuer: string; clientId: string },
  appOrigin?: string,
) {
  const version = (revision: number) => hash(["tps", userId, revision]);
  async function lock(tx: StoreSession) {
    if (
      !(
        await tx.query(
          sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`,
        )
      ).length
    )
      throw new StoreError(
        "account_unavailable",
        "This Milton account is unavailable.",
        403,
      );
  }
  async function snapshot(tx: StoreSession) {
    // All heads (including archive state) and active samples in one
    // tenant-locked snapshot. Never page this input.
    const heads = await cardHeads(tx, userId);
    const samples = await tx.query<Sample>(
      sql`SELECT s.id,s.report,s.kind_id,k.label AS kind,s.context,s.body,to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,
      to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM samples s JOIN sample_kinds k ON k.user_id=s.user_id AND k.id=s.kind_id
      WHERE s.user_id=${userId} AND s.retired_at IS NULL ORDER BY s.created_at,s.id`,
    );
    const report = (
      await tx.query<Report>(
        sql`SELECT revision,body,source_hash FROM tps_reports WHERE user_id=${userId}`,
      )
    )[0];
    // Without samples the fence is the card fingerprint alone, so every
    // pre-0017 snapshot stays valid.
    const fingerprint = samples.length
      ? hash([cardFingerprint(heads), samples.map((s) => s.id)])
      : cardFingerprint(heads);
    const active = heads.filter((h) => !h.archived && h.body.trim());
    const documents = assembleDocuments(active, samples);
    return {
      heads,
      samples,
      report,
      fingerprint,
      active,
      documents,
      ready: report ? report.source_hash === fingerprint : documents.is_empty,
      version: version(report?.revision ?? 0),
    };
  }
  async function readTpsSession(tx: StoreSession) {
    await lock(tx);
    if (actor) await assertTrialAccess(tx, userId, appOrigin);
    let current = await snapshot(tx);
    // Assembly is deterministic, so a compiled snapshot that lags its sources is
    // rebuilt here instead of reported. An empty account without a snapshot is
    // ready as it is and stays unwritten until its first save.
    if (!current.ready) {
      await publish(tx, current, await assemble(tx, current.documents));
      current = await snapshot(tx);
    }
    return {
      report: {
        text: current.documents.full,
        version: current.version,
        is_empty: current.documents.is_empty,
      },
      documents: current.documents,
    };
  }
  async function receipt(tx: StoreSession, id: string) {
    return (
      await tx.query<Receipt>(
        sql`SELECT input_hash,source_hash,completed,deadline>clock_timestamp() AS live,result_json,
        memo_update_state,memo_update_day::text,(SELECT memo_updates_enabled FROM store_config WHERE singleton=1) AS memo_updates_enabled
        FROM save_requests WHERE user_id=${userId} AND request_id=${id}`,
      )
    )[0];
  }
  async function complete(
    tx: StoreSession,
    result: SaveOutcome,
    changed = false,
  ) {
    const rows = await tx.query<UpdateReceipt>(
      sql`UPDATE save_requests SET completed=true,result_json=${JSON.stringify(result)}::jsonb,
      memo_update_state=CASE WHEN memo_update_state='held' THEN CASE WHEN ${changed} THEN 'charged' ELSE 'released' END ELSE memo_update_state END
      WHERE user_id=${userId} AND request_id=${result.request_id} AND NOT completed
      RETURNING memo_update_state,memo_update_day::text,(SELECT memo_updates_enabled FROM store_config WHERE singleton=1) AS memo_updates_enabled`,
    );
    return withMemoUpdate(result, rows[0]!);
  }
  async function assemble(tx: StoreSession, documents: Documents) {
    // Every source byte is preserved; only headings, when lines, sample context
    // and quoting, and blank lines are added. Each body has its own cap.
    const limits = await readLimits(tx);
    const cap = Math.min(limits.report_body_bytes, 262144);
    if (
      utf8Bytes(documents.cover) > cap ||
      documents.reports.some((r) => utf8Bytes(r.body) > cap) ||
      utf8Bytes(documents.full) > 1572864
    )
      throw new StoreError(
        "tps_body_limit",
        "A report exceeds its size limit. Nothing was truncated or published.",
        422,
      );
    return documents.full;
  }
  async function publish(
    tx: StoreSession,
    current: Awaited<ReturnType<typeof snapshot>>,
    body: string,
  ) {
    const next = (current.report?.revision ?? 0) + 1;
    await tx.query(sql`INSERT INTO tps_reports(user_id,revision,body,source_hash) VALUES (${userId},${next},${body},${current.fingerprint})
      ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,source_hash=excluded.source_hash,created_at=clock_timestamp()`);
    return version(next);
  }
  return {
    /** The cover sheet and the five reports at one version. */
    async readDocuments(): Promise<Documents & { version: string }> {
      return db
        .transaction(async (tx) => {
          const current = await readTpsSession(tx);
          return { ...current.documents, version: current.report.version };
        })
        .catch((error) => {
          throw databaseFailure(error);
        });
    },
    memoUpdates: () => memoUpdates(db, userId),
    async getTpsReport(): Promise<CompiledReport> {
      return db
        .transaction(async (tx) => (await readTpsSession(tx)).report)
        .catch((error) => {
          throw databaseFailure(error);
        });
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
      const input = parsed.data;
      const inputHash = hash(input);
      // Every save is exact: the caller sends the bytes, and no model rewrites them.
      const structured =
        input.rules !== undefined ||
        input.exact_edits !== undefined ||
        input.moves !== undefined ||
        input.sample !== undefined ||
        input.retire_samples !== undefined;
      const result = (
        status: SaveOutcome["status"],
        rest: Partial<SaveOutcome> = {},
      ): SaveOutcome => ({ status, request_id: input.request_id, ...rest });
      const ctx: SaveContext = {
        db,
        userId,
        actor,
        appOrigin,
        input,
        inputHash,
        result,
        lock,
        snapshot,
        receipt,
        complete,
        assemble,
        publish,
      };
      const claim = await claimSave(ctx, structured);
      if (claim.outcome) return claim.outcome;
      try {
        return await applySave(ctx, claim);
      } catch (error) {
        return recoverSave(ctx, error);
      }
    },
  };
}
