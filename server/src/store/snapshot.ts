import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { guidePresentation, type GuidePresentation } from "../guides/store";
import { cardHeadsJson, cardFingerprint, type CardHead } from "./cards";
import type { StoreSession } from "./database";
import { accountUnavailable } from "./accounts";
import { StoreError } from "./errors";
import { parseLimits, reportCap } from "./limits";
import {
  assembleDocuments,
  type Documents,
  type ReportIntent,
  type ReportId,
  type Sample,
} from "./reports";
import { sampleHeads } from "./samples";

// One account's cards and samples as reads and saves see them: the snapshot
// statement and the hash behind versions and fingerprints.
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The refusal for an intent whose kind_id is not the account's in that report. */
export const invalidKind = () =>
  new StoreError(
    "invalid_kind",
    "kind_id must name an existing personal kind in this report. Nothing was read.",
    400,
  );

/** Whether an intent's kind_id names one of the account's kinds in its report. */
export const kindValid = (userId: string, intent: ReportIntent) =>
  intent.kind_id
    ? sql`EXISTS(SELECT 1 FROM sample_kinds WHERE user_id=${userId} AND id=${intent.kind_id} AND report=${intent.report})`
    : sql`true`;

/** What `readSnapshot` reads in one statement. */
export type Snapshot = {
  /** The account exists and is active. */
  open: boolean;
  heads: CardHead[];
  samples: Sample[];
  /** The source fingerprint: card heads and active sample IDs, kinds and revisions. */
  fingerprint: string;
  active: CardHead[];
  documents: Documents;
  /** The fingerprint of the assembled documents; every save fences on it. */
  version: string;
};

// Every active sample revision fences writes, including samples outside eight.
const version = (userId: string, documents: Documents, samples: Sample[]) =>
  hash([
    "documents",
    userId,
    documents.cover,
    documents.reports.map((r) => [
      r.id,
      r.body,
      samples
        .filter((s) => s.report === r.id)
        .map((s) => [s.id, s.kind_id, s.kind, s.revision]),
    ]),
  ]);

export async function readSnapshot(
  session: StoreSession,
  userId: string,
  intent?: ReportIntent,
  includeGuides = false,
): Promise<
  Snapshot & {
    served?: Documents;
    guides: Partial<Record<ReportId, GuidePresentation>>;
  }
> {
  // One statement reads every head (including archive state) and the active
  // samples, so a read without a transaction still sees a save whole or not
  // at all. Never page this input.
  const row = (
    await session.query<{
      open: boolean;
      heads: CardHead[];
      samples: Sample[];
      kind_valid: boolean;
      limits: unknown;
      guides: Partial<Record<ReportId, GuidePresentation>>;
    }>(
      sql`SELECT EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active') AS open,
      (${cardHeadsJson(userId)}) AS heads,
      (SELECT coalesce(json_agg(json_build_object('id',s.id,'report',s.report,'kind_id',s.kind_id,'kind',k.label,'context',s.context,'revision',s.version,'body',s.body,
        'date',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
        'lexical_rank',${intent ? sql`ts_rank(s.search,replace(plainto_tsquery('english',${intent.situation})::text,'&','|')::tsquery)` : sql`0`},
        'revised_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'created_at',to_char(s.original_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY s.created_at,s.id),'[]'::json)
        FROM (${sampleHeads(userId)}) s JOIN sample_kinds k ON k.user_id=s.user_id AND k.id=s.kind_id
        WHERE s.user_id=${userId} AND NOT s.retired) AS samples,
      ${intent ? kindValid(userId, intent) : sql`true`} AS kind_valid,
      ${intent ? sql`(SELECT limits_json FROM store_config WHERE singleton=1)` : sql`NULL`} AS limits,
      (${includeGuides ? guidePresentation(userId) : sql`SELECT '{}'::json`}) AS guides`,
    )
  )[0]!;
  if (!row.open) throw accountUnavailable();
  if (!row.kind_valid) throw invalidKind();
  const { heads, samples } = row;
  // Without samples the source fingerprint is the card fingerprint alone.
  const fingerprint = samples.length
    ? hash([
        cardFingerprint(heads),
        samples.map((s) => [s.id, s.kind_id, s.revision]),
      ])
    : cardFingerprint(heads);
  const active = heads.filter((h) => !h.archived && h.body.trim());
  const documents = assembleDocuments(active, samples);
  return {
    open: row.open,
    guides: row.guides,
    heads,
    samples,
    fingerprint,
    active,
    documents,
    version: version(userId, documents, samples),
    ...(intent
      ? {
          served: assembleDocuments(active, samples, {
            report: intent.report,
            intent,
            cap: reportCap(parseLimits(row.limits)),
          }),
        }
      : {}),
  };
}
