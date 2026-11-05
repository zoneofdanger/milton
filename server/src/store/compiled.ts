import { cardHeadsJson, cardFingerprint, type CardHead } from "./cards";
import {
  assembleDocuments,
  assembleExport,
  AUDIENCES,
  FILINGS,
  PURPOSES,
  REGISTERS,
  REPORT_IDS,
  SERVED_SAMPLES,
  type Documents,
  type ReportIntent,
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
import type {
  Receipt,
  SaveContext,
  SaveOutcome,
  Snapshot,
} from "./save-context";
import { runSave } from "./save";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = z
  .string()
  .max(131072)
  .refine(
    (v) => v.isWellFormed() && !v.includes("\0") && utf8Bytes(v) <= 131072,
  );
export const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => v.isWellFormed() && !/[\r\n\0]/.test(v));
const oneKind = "A sample needs kind_id or new_kind, not both.";
const badRules =
  "rules takes 1–100 entries, each with a report (one of the five, doc or cover) and non-blank text. Nothing was changed.";
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
      audience: z
        .enum(AUDIENCES)
        .optional()
        .describe("Who it was written for."),
      purpose: z.enum(PURPOSES).optional().describe("What it does."),
      register: z.enum(REGISTERS).optional().describe("How formal it is."),
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
      "Optional approved sample to file under a report, offered once when the person approves a draft and sent only after they say yes. Every approved sample stays; a report read serves the eight that best fit its intent. Remove one with retire_samples or replace it with replaces; either is reported in samples_retired. Text identical to an active sample of the kind files nothing.",
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
) {
  const unavailable = () =>
    new StoreError(
      "account_unavailable",
      "This Milton account is unavailable.",
      403,
    );
  async function lock(tx: StoreSession) {
    if (
      !(
        await tx.query(
          sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`,
        )
      ).length
    )
      throw unavailable();
  }
  // The version is a fingerprint of what any read can serve: the cover sheet
  // and each report's text (newest eight samples) with every active sample's ID
  // and kind, since a read with an intent may serve any of them. Labels never
  // change, so the ID covers them. The same cards and samples always give the
  // same version, and the user ID keeps it to one account.
  const version = (documents: Documents, samples: Sample[]) =>
    hash([
      "documents",
      userId,
      documents.cover,
      documents.reports.map((r) => [
        r.id,
        r.body,
        samples
          .filter((s) => s.report === r.id)
          .map((s) => [s.id, s.kind_id, s.kind]),
      ]),
    ]);
  // A report read's eight samples: label overlap with the intent (audience,
  // purpose), then full-text rank of the situation against context and body
  // (any word of it, through the stored search vector), then newest, then id.
  const ranked = (intent: ReportIntent) =>
    sql`(SELECT coalesce(json_agg(r.id ORDER BY r.n),'[]'::json) FROM (
      SELECT s.id,row_number() OVER (ORDER BY
        COALESCE(s.audience=${intent.audience ?? null},false)::int+COALESCE(s.purpose=${intent.purpose ?? null},false)::int DESC,
        ts_rank(s.search,q.q) DESC,s.created_at DESC,s.id) AS n
      FROM samples s,(SELECT replace(plainto_tsquery('english',${intent.situation})::text,'&','|')::tsquery AS q) q
      WHERE s.user_id=${userId} AND s.report=${intent.report} AND s.retired_at IS NULL
      ORDER BY n LIMIT ${SERVED_SAMPLES}) r)`;
  async function snapshot(
    session: StoreSession,
    intent?: ReportIntent,
  ): Promise<Snapshot & { served?: Documents }> {
    // One statement reads every head (including archive state) and the active
    // samples, so a read without a transaction still sees a save whole or not
    // at all. Never page this input.
    const row = (
      await session.query<{
        open: boolean;
        heads: CardHead[];
        samples: Sample[];
        ranked: string[] | null;
      }>(
        sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
      (${cardHeadsJson(userId)}) AS heads,
      (SELECT coalesce(json_agg(json_build_object('id',s.id,'report',s.report,'kind_id',s.kind_id,'kind',k.label,'context',s.context,'body',s.body,
        'date',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
        'audience',s.audience,'purpose',s.purpose,'register',s.register,
        'created_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY s.created_at,s.id),'[]'::json)
        FROM samples s JOIN sample_kinds k ON k.user_id=s.user_id AND k.id=s.kind_id
        WHERE s.user_id=${userId} AND s.retired_at IS NULL) AS samples,
      ${intent ? ranked(intent) : sql`NULL`} AS ranked`,
      )
    )[0]!;
    const { heads, samples } = row;
    // Without samples the source fingerprint is the card fingerprint alone.
    const fingerprint = samples.length
      ? hash([cardFingerprint(heads), samples.map((s) => s.id)])
      : cardFingerprint(heads);
    const active = heads.filter((h) => !h.archived && h.body.trim());
    const documents = assembleDocuments(active, samples);
    return {
      open: row.open,
      heads,
      samples,
      fingerprint,
      active,
      documents,
      version: version(documents, samples),
      ...(intent && row.ranked
        ? {
            served: assembleDocuments(active, samples, {
              report: intent.report,
              ids: row.ranked,
            }),
          }
        : {}),
    };
  }
  /** A read assembles the documents from cards and samples. It takes no lock
   * and writes nothing: one statement for the snapshot, then the trial gate
   * for an assistant. The size cap bounds saves; a read serves what is on file. */
  async function read(intent?: ReportIntent) {
    try {
      const current = await snapshot(db, intent);
      if (!current.open) throw unavailable();
      if (actor) await assertTrialAccess(db, userId);
      return current;
    } catch (error) {
      throw databaseFailure(error);
    }
  }
  async function receipt(tx: StoreSession, id: string) {
    return (
      await tx.query<Receipt>(
        sql`SELECT input_hash,result_json FROM save_requests WHERE user_id=${userId} AND request_id=${id}`,
      )
    )[0];
  }
  async function checkSize(tx: StoreSession, documents: Documents) {
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
  }
  return {
    /** The cover sheet and the five reports at one version. With an intent,
     * that report serves the eight samples ranked for it; the version stays
     * the same for every intent. */
    async readDocuments(
      intent?: ReportIntent,
    ): Promise<Documents & { version: string }> {
      const current = await read(intent);
      return {
        ...(current.served ?? current.documents),
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
        input,
        inputHash,
        result,
        lock,
        snapshot,
        receipt,
        checkSize,
      };
      return runSave(ctx, structured);
    },
  };
}
