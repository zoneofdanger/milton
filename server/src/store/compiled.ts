import { recordAcceptedChange } from "./provenance";
import {
  cardHeads,
  cardFingerprint,
  headingLine,
  type CardHead,
} from "./cards";
import {
  assembleDocuments,
  resolveReportId,
  FILINGS,
  REPORT_IDS,
  type Documents,
  type Sample,
} from "./reports";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { StoreDatabase, StoreSession } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { readLimits, utf8Bytes } from "./index";
import { exactEditsProposal, exactMoves } from "../exact-edits";
import { MAX_REQUEST_BYTES } from "../http";
import { assertTrialAccess } from "./trials";
import { lockSpendPolicy } from "./spend-policy";
import {
  admitMemoUpdate,
  claimClock,
  memoUpdates,
  withMemoUpdate,
  type MemoUpdate,
  type UpdateReceipt,
} from "./memo-updates";

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
const nameTheReport = "Name the report and send the rule's text in rules.";
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
      "Corrections and removals of existing rules. Copy each before verbatim from a current rule; it must occur exactly once across all rules and fit within one rule. after is the exact replacement, or empty to remove it; a rule left empty is removed. All edits use the original snapshot and must not overlap. Preserve complete conditions, subjects and scope.",
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
      "Optional approved sample to file under a report, offered once when the person approves a draft and sent only after they say yes. At most two stay per kind; Milton retires the oldest beyond that and reports it in samples_retired.",
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
      "Copy the opaque version from the latest get_cover_sheet or get_report result or tps_report_unavailable error. Never invent a version.",
    ),
});
export type SaveMemoInput = z.infer<typeof saveMemoInput>;
const retiredSample = z.object({
  id: z.string(),
  reason: z.enum(["replaced", "removed", "evicted"]),
});
// Stored receipts may hold needs_clarification from the retired model path.
const outcomeSchema = z.object({
  status: z.enum([
    "saved",
    "unchanged",
    "needs_clarification",
    "conflict",
    "in_progress",
    "failed",
  ]),
  request_id: z.string(),
  version: z.string().optional(),
  question: z.string().optional(),
  error: z.string().optional(),
  /** A StoreError's client-facing message; never raw internal text. */
  message: z.string().optional(),
  samples_retired: z.array(retiredSample).optional(),
});
export type SaveOutcome = z.infer<typeof outcomeSchema> & {
  memo_update?: MemoUpdate;
};
export type CompiledReport = {
  text: string;
  version: string;
  is_empty: boolean;
};
export type { Documents, ReportDocument } from "./reports";
type Head = CardHead;
type Report = { revision: number; body: string; source_hash: string };
type Receipt = UpdateReceipt & {
  input_hash: string;
  source_hash: string;
  completed: boolean;
  live: boolean;
  result_json: unknown;
};
const deadlineSeconds = 40;

/** A card's description, derived without a model: the first non-blank line,
 * trimmed and cut to fit the byte cap. Descriptions are never printed. */
function describe(body: string, maxBytes: number) {
  const line =
    body
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  if (utf8Bytes(line) <= maxBytes) return line;
  let cut = "";
  for (const char of line) {
    if (utf8Bytes(cut + char + "…") > maxBytes) break;
    cut += char;
  }
  return cut.trimEnd() + "…";
}

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
  async function chargeWrite(tx: StoreSession) {
    const limits = await readLimits(tx);
    const charged =
      await tx.query(sql`INSERT INTO usage_daily(user_id,day_utc,writes)
      VALUES (${userId},(clock_timestamp() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(user_id,day_utc) DO UPDATE SET writes=usage_daily.writes+1
      WHERE usage_daily.writes < ${limits.daily_writes} RETURNING writes`);
    if (!charged.length)
      throw new StoreError(
        "rate_limited",
        "The daily save limit has been reached.",
        429,
      );
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
      const claim = await db
        .transaction(async (tx) => {
          // One short shared lock for memo-update admission, then the account lock.
          const policy = await lockSpendPolicy(tx);
          await lock(tx);
          const existing = await receipt(tx, input.request_id);
          if (existing) {
            if (existing.input_hash !== inputHash)
              throw new StoreError(
                "request_id_reused",
                "This request ID belongs to different input. Reuse the exact original request to recover its result.",
                409,
              );
            if (existing.completed)
              return {
                outcome: withMemoUpdate(
                  outcomeSchema.parse(existing.result_json),
                  existing,
                  true,
                ),
              };
            if (existing.live)
              return {
                outcome: withMemoUpdate(result("in_progress"), existing, true),
              };
            return {
              outcome: await complete(
                tx,
                result("failed", { error: "request_expired" }),
              ),
            };
          }
          // After replay, so a receipt from before exact-only saves still recovers.
          if (!structured)
            throw new StoreError("invalid_input", nameTheReport, 400);
          await assertTrialAccess(tx, userId, appOrigin);
          const current = await snapshot(tx);
          if (input.expected_version !== current.version)
            return {
              outcome: result("conflict", { version: current.version }),
            };
          const limits = await readLimits(tx);
          if (utf8Bytes(JSON.stringify(input)) > MAX_REQUEST_BYTES)
            throw new StoreError(
              "request_too_large",
              "The save request is too large.",
              413,
            );
          if (utf8Bytes(input.text) > limits.body_bytes)
            throw new StoreError(
              "memo_body_limit",
              "The submitted memo is too large.",
              422,
            );
          const clock = await claimClock(tx);
          const updateDay = await admitMemoUpdate(tx, userId, policy, clock);
          await tx.query(sql`INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,reserved_micros,deadline,claimed_at,created_at,memo_update_day,memo_update_state)
          VALUES (${userId},${input.request_id},${inputHash},${current.fingerprint},0,${clock.at}::timestamptz+${deadlineSeconds}*interval '1 second',${clock.at}::timestamptz,${clock.at}::timestamptz,${updateDay}::date,${updateDay ? "held" : "none"})`);
          return { current };
        })
        .catch(async (error) => {
          const failure = databaseFailure(error);
          if (failure.code !== "store_unavailable") throw failure;
          // A claim may have committed without its acknowledgment. Never dispatch
          // from an uncertain claim or release a live hold on a failed lookup.
          try {
            return await db.transaction(async (tx) => {
              await lock(tx);
              const existing = await receipt(tx, input.request_id);
              if (existing && existing.input_hash !== inputHash)
                throw new StoreError(
                  "request_id_reused",
                  "This request ID belongs to different input.",
                  409,
                );
              if (existing?.completed)
                return {
                  outcome: withMemoUpdate(
                    outcomeSchema.parse(existing.result_json),
                    existing,
                    true,
                  ),
                };
              if (existing?.live)
                return {
                  outcome: withMemoUpdate(
                    result("in_progress"),
                    existing,
                    true,
                  ),
                };
              if (existing)
                return {
                  outcome: await complete(
                    tx,
                    result("failed", { error: "request_expired" }),
                  ),
                };
            });
          } catch (recoveryError) {
            if (
              recoveryError instanceof StoreError &&
              recoveryError.code === "request_id_reused"
            )
              throw recoveryError;
          }
          throw new StoreError(
            "save_outcome_unknown",
            "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
            503,
            { request_id: input.request_id },
          );
        });
      if (!claim)
        throw new StoreError(
          "save_outcome_unknown",
          "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
          503,
          { request_id: input.request_id },
        );
      if (claim.outcome) return claim.outcome;
      try {
        // Every anchor resolves against the claimed snapshot.
        const cards = claim.current.active.map((h) => ({
          id: h.id,
          description: h.description,
          text: h.body,
        }));
        const { updates, retire } = exactEditsProposal(
          cards,
          input.exact_edits ?? [],
        );
        const moves = exactMoves(
          cards,
          (input.moves ?? []).map((m) => ({
            before: m.before,
            report: m.report === "doc" ? "document" : m.report,
          })),
        );
        // The active rules as this save leaves them: edits, removals and moves
        // applied. A changed rule may not end up byte-identical to another in
        // its report, because neither could then be targeted; an untouched
        // identical pair does not block the save.
        const retiring = new Set(retire);
        const edited = new Map(updates.map((u) => [u.id, u.text]));
        const movedTo = new Map(moves.map((m) => [m.id, m.report]));
        const key = (report: string, body: string) =>
          JSON.stringify([report, body]);
        const after = claim.current.active
          .filter((h) => !retiring.has(h.id))
          .map((h) => {
            const report = movedTo.get(h.id) ?? h.report;
            const body = edited.get(h.id) ?? h.body;
            return {
              report,
              body,
              key: key(report, body),
              changed: report !== h.report || body !== h.body,
            };
          });
        const counts = new Map<string, number>();
        for (const card of after)
          counts.set(card.key, (counts.get(card.key) ?? 0) + 1);
        const collision = after.find(
          (card) => card.changed && counts.get(card.key)! > 1,
        );
        if (collision)
          throw new StoreError(
            "edit_conflict",
            `This save would leave two identical rules in ${collision.report === "cover" ? "the cover sheet" : `the ${collision.report} report`}: "${describe(collision.body, 120)}". Change the wording or remove one of them. Nothing was changed.`,
            409,
          );
        // A rule whose bytes match a rule in the same report after this save, or
        // an earlier entry in this request, is skipped.
        const onFile = new Set(after.map((card) => card.key));
        const creates: { report: (typeof FILINGS)[number]; text: string }[] =
          [];
        for (const rule of input.rules ?? []) {
          const report = rule.report === "doc" ? "document" : rule.report;
          const key = JSON.stringify([report, rule.text]);
          if (onFile.has(key)) continue;
          onFile.add(key);
          creates.push({ report, text: rule.text });
        }
        return await db.transaction(async (tx) => {
          await lock(tx);
          const pending = await receipt(tx, input.request_id);
          if (!pending || pending.input_hash !== inputHash)
            throw new StoreError(
              "request_unavailable",
              "The save request is unavailable.",
              503,
            );
          if (pending.completed)
            return withMemoUpdate(
              outcomeSchema.parse(pending.result_json),
              pending,
              true,
            );
          if (!pending.live)
            return complete(tx, result("failed", { error: "request_expired" }));
          await assertTrialAccess(tx, userId, appOrigin);
          const current = await snapshot(tx);
          if (
            current.fingerprint !== claim.current.fingerprint ||
            current.version !== input.expected_version
          )
            return complete(
              tx,
              result("conflict", { version: current.version }),
            );
          const attribution = JSON.stringify({
            kind: "assistant",
            issuer: actor.issuer,
            client_id: actor.clientId,
          });
          const sampleConflict = (message: string) =>
            new StoreError(
              "sample_conflict",
              message + " Nothing was changed.",
              409,
            );
          // Structured saves change samples and cards together, or not at all.
          const retired: z.infer<typeof retiredSample>[] = [];
          const retireSample = async (
            id: string,
            reason: "replaced" | "removed",
            kindId?: string,
          ) =>
            (
              await tx.query(sql`UPDATE samples SET retired_at=clock_timestamp(),retire_reason=${reason},retired_request_id=${input.request_id}
                WHERE user_id=${userId} AND id=${id} AND retired_at IS NULL ${kindId === undefined ? sql`` : sql`AND kind_id=${kindId}`} RETURNING id`)
            ).length > 0;
          const applySamples = async () => {
            for (const id of input.retire_samples ?? []) {
              if (!(await retireSample(id, "removed")))
                throw sampleConflict(
                  "Each sample to retire must be an active sample, listed once.",
                );
              retired.push({ id, reason: "removed" });
            }
            const sample = input.sample;
            if (!sample) return;
            const report = resolveReportId(sample.report)!;
            let kindId = sample.kind_id;
            if (kindId === undefined) {
              // A label already used in this report, in any letter case, is
              // that kind, even when none of its samples is still listed.
              kindId = (
                await tx.query<{ id: string }>(
                  sql`SELECT id FROM sample_kinds WHERE user_id=${userId} AND report=${report} AND lower(label)=lower(${sample.new_kind!})`,
                )
              )[0]?.id;
              if (kindId === undefined) {
                kindId = randomUUID();
                await tx.query(
                  sql`INSERT INTO sample_kinds(user_id,id,report,label) VALUES (${userId},${kindId},${report},${sample.new_kind!})`,
                );
              }
            } else if (
              !(
                await tx.query(
                  sql`SELECT 1 FROM sample_kinds WHERE user_id=${userId} AND id=${kindId} AND report=${report}`,
                )
              ).length
            )
              throw sampleConflict(
                "kind_id must name an existing kind in this report.",
              );
            if (sample.replaces !== undefined) {
              if (!(await retireSample(sample.replaces, "replaced", kindId)))
                throw sampleConflict(
                  "replaces must name an active sample of the same kind.",
                );
              retired.push({ id: sample.replaces, reason: "replaced" });
            }
            await tx.query(sql`INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,replaces_id)
              VALUES (${userId},${randomUUID()},${report},${kindId},${sample.context},${sample.text},${attribution},${sample.replaces ?? null})`);
            // Newest two per kind stay; every eviction is reported.
            const evicted = await tx.query<{ id: string }>(sql`UPDATE samples
              SET retired_at=clock_timestamp(),retire_reason='evicted',retired_request_id=${input.request_id}
              WHERE user_id=${userId} AND id IN (SELECT id FROM samples WHERE user_id=${userId} AND kind_id=${kindId} AND retired_at IS NULL
              ORDER BY created_at DESC,id DESC OFFSET 2) RETURNING id`);
            for (const { id } of evicted.toSorted((a, b) =>
              a.id.localeCompare(b.id),
            ))
              retired.push({ id, reason: "evicted" });
          };
          const finish = async (before: typeof current) => {
            const updated = await snapshot(tx);
            const body = await assemble(tx, updated.documents);
            const publishedVersion = await publish(tx, updated, body);
            const changed = await recordAcceptedChange(tx, {
              userId,
              requestId: input.request_id,
              operation: "save_memo",
              request: {
                text: input.text,
                ...(input.rules ? { rules: input.rules } : {}),
                ...(input.exact_edits
                  ? { exact_edits: input.exact_edits }
                  : {}),
                ...(input.moves ? { moves: input.moves } : {}),
                ...(input.sample ? { sample: input.sample } : {}),
                ...(input.retire_samples
                  ? { retire_samples: input.retire_samples }
                  : {}),
              },
              actor: JSON.parse(attribution),
              transformation: { pipeline: "exact:v1" },
              before: before.heads,
              after: updated.heads,
              beforeTps: before.version,
              afterTps: publishedVersion,
              beforeSource: before.fingerprint,
              afterSource: updated.fingerprint,
            });
            // A sample change touches no cards but is still one user-directed
            // filing, so it charges one memo update.
            return complete(
              tx,
              result("saved", {
                version: publishedVersion,
                ...(retired.length ? { samples_retired: retired } : {}),
              }),
              changed || samplesChanged,
            );
          };
          const limits = await readLimits(tx);
          const known = new Map(current.active.map((h) => [h.id, h]));
          // A rule cannot be moved and retired at once, including by an exact
          // edit that empties it.
          if (moves.some((m) => retire.includes(m.id)))
            throw new StoreError(
              "move_conflict",
              "A rule this save removes cannot also move. Nothing was changed.",
              409,
            );
          if (
            current.active.length - retire.length + creates.length >
            limits.memos
          )
            throw new StoreError(
              "memo_count_limit",
              "The memo count limit has been reached. Nothing was changed.",
              422,
            );
          if (
            [...updates, ...creates].some(
              (m) => utf8Bytes(m.text) > limits.body_bytes,
            )
          )
            throw new StoreError(
              "memo_body_limit",
              "A rule exceeds its size limit. Nothing was changed.",
              422,
            );
          // Milton prints each report's heading; one inside card text would repeat.
          if (
            creates.some((m) => headingLine.test(m.text)) ||
            updates.some(
              (m) =>
                known.get(m.id)?.body !== m.text && headingLine.test(m.text),
            )
          )
            throw new StoreError(
              "card_heading",
              "Instruction text cannot contain Markdown headings; Milton adds each report's heading. Nothing was changed.",
              422,
            );
          // Moving a rule to where it already is changes nothing.
          const moveTo = new Map(
            moves
              .filter((m) => known.get(m.id)!.report !== m.report)
              .map((m) => [m.id, m.report]),
          );
          const samplesChanged =
            input.sample !== undefined || input.retire_samples !== undefined;
          const unchanged =
            !samplesChanged &&
            moveTo.size === 0 &&
            creates.length === 0 &&
            retire.length === 0 &&
            updates.every((m) => known.get(m.id)?.body === m.text);
          if (unchanged && current.ready)
            return complete(
              tx,
              result("unchanged", { version: current.version }),
            );
          await chargeWrite(tx);
          const append = async (
            h: Pick<Head, "id" | "version" | "description" | "body" | "report">,
            archived: boolean,
            kind: string,
          ) => {
            await tx.query(sql`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,archived,report,reason,actor_json,details_json)
              VALUES (${userId},${h.id},${h.version + 1},${h.description},${h.body},${archived},${h.report},'Filed memo',${attribution},${JSON.stringify({ kind, request_id: input.request_id })})`);
          };
          // Only explicit targets get new history rows. Omission preserves bytes,
          // descriptions, reports and versions; it never means retirement. A
          // rule both edited and moved gets one version carrying both.
          for (const memo of updates) {
            const old = known.get(memo.id)!;
            if (old.body === memo.text) continue;
            await append(
              {
                ...old,
                body: memo.text,
                report: moveTo.get(memo.id) ?? old.report,
              },
              false,
              "update",
            );
            moveTo.delete(memo.id);
          }
          for (const [id, report] of moveTo)
            await append({ ...known.get(id)!, report }, false, "move");
          for (const memo of creates) {
            const id = randomUUID();
            await tx.query(
              sql`INSERT INTO instruction_cards(user_id,id) VALUES (${userId},${id})`,
            );
            await append(
              {
                id,
                version: 0,
                description: describe(
                  memo.text,
                  Math.min(limits.description_bytes, 500),
                ),
                body: memo.text,
                report: memo.report,
              },
              false,
              "create",
            );
          }
          for (const id of retire)
            await append(known.get(id)!, true, "archive");
          await applySamples();
          return finish(current);
        });
      } catch (error) {
        const failure = databaseFailure(error);
        // A committed result wins even when the connection failed while returning it.
        return db
          .transaction(async (tx) => {
            await lock(tx);
            const existing = await receipt(tx, input.request_id);
            if (existing?.completed)
              return withMemoUpdate(
                outcomeSchema.parse(existing.result_json),
                existing,
                true,
              );
            if (!existing) throw failure;
            // databaseFailure yields only StoreErrors, whose messages are written
            // for clients; unknown errors carry its generic message.
            return complete(
              tx,
              result("failed", {
                error: failure.code,
                message: failure.message,
              }),
            );
          })
          .catch(() => {
            throw new StoreError(
              "save_outcome_unknown",
              "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
              503,
              { request_id: input.request_id },
            );
          });
      }
    },
  };
}
