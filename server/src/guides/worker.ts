import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { StoreDatabase, StoreSession } from "../store/database";
import type { ReportId, Sample } from "../store/reports";
import { sampleHeads } from "../store/samples";
import { guideEligible, guideEpoch } from "./store";
import {
  guideRequest,
  knownUsage,
  validateGuide,
  MAX_INPUT_BYTES,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  type GuideProvider,
} from "./provider";

// USD microdollars: $5/M input, $25/M output, no caching/tools/batch.
export const GUIDE_RESERVATION_MICROS =
  MAX_INPUT_TOKENS * 5 + MAX_OUTPUT_TOKENS * 25;
const cost = (usage: { input_tokens: number; output_tokens: number }) =>
  usage.input_tokens * 5 + usage.output_tokens * 25;
type Claim = {
  user_id: string;
  report: ReportId;
  source_version: number;
  epoch: number;
  token: string;
  samples: Sample[];
};
const key = (id: string) =>
  createHash("sha256").update(`guide-budget:${id}`).digest("hex");
const fence = (c: Claim) => sql`user_id=${c.user_id} AND report=${c.report}
  AND source_version=${c.source_version} AND lease_token=${c.token} AND lease_until>clock_timestamp()
  AND EXISTS(SELECT 1 FROM guide_accounts WHERE user_id=${c.user_id} AND epoch=${c.epoch})
  AND ${guideEligible(c.user_id)}`;
const valid = async (db: StoreSession, c: Claim) =>
  (await db.query(sql`SELECT 1 FROM report_guides WHERE ${fence(c)}`)).length >
  0;

async function claim(db: StoreDatabase): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    // Terminal recovery is durable; reads also label expired exhausted work honestly.
    await tx.query(sql`UPDATE report_guides SET status='failed',reason='attempts_exhausted',lease_token=NULL,lease_until=NULL
      WHERE status='running' AND lease_until<=clock_timestamp() AND attempts>=2`);
    const [row] = await tx.query<{
      user_id: string;
      report: ReportId;
      source_version: number;
    }>(sql`
      SELECT g.user_id,g.report,g.source_version FROM report_guides g
      WHERE g.status IN ('queued','running') AND g.attempts<2 AND g.next_attempt_at<=clock_timestamp()
        AND (g.lease_until IS NULL OR g.lease_until<=clock_timestamp()) AND ${guideEligible(sql`g.user_id`)}
      ORDER BY g.next_attempt_at,g.user_id,g.report FOR UPDATE OF g SKIP LOCKED LIMIT 1`);
    if (!row) return;
    const epoch = await guideEpoch(tx, row.user_id);
    if (epoch === undefined) return;
    const token = randomUUID();
    await tx.query(sql`UPDATE report_guides SET status='running',reason='preparing',attempts=attempts+1,
      lease_token=${token},lease_until=clock_timestamp()+interval '150 seconds' WHERE user_id=${row.user_id} AND report=${row.report}`);
    const samples = await tx.query<
      Sample & Record<string, unknown>
    >(sql`SELECT h.id,h.version AS revision,h.report,h.kind_id,k.label AS kind,h.context,h.body
      FROM (${sampleHeads(row.user_id)}) h JOIN sample_kinds k ON k.user_id=h.user_id AND k.id=h.kind_id
      WHERE NOT h.retired AND h.report=${row.report} ORDER BY h.id`);
    return { ...row, epoch, token, samples };
  });
}
async function reserve(db: StoreDatabase, c: Claim) {
  return db.transaction(async (tx) => {
    await tx.query(
      sql`SELECT singleton FROM guide_budget_lock WHERE singleton=1 FOR UPDATE`,
    );
    if (!(await valid(tx, c))) return false;
    const [spent] = await tx.query<{
      month: number;
      day: number;
      account: number;
    }>(sql`SELECT
      coalesce(sum(amount_micros),0)::int AS month,
      coalesce(sum(amount_micros) FILTER(WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS day,
      coalesce(sum(amount_micros) FILTER(WHERE account_key=${key(c.user_id)} AND created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS account
      FROM guide_spend WHERE created_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
    if (
      !spent ||
      spent.month + GUIDE_RESERVATION_MICROS > 20_000_000 ||
      spent.day + GUIDE_RESERVATION_MICROS > 5_000_000 ||
      spent.account + GUIDE_RESERVATION_MICROS > 2_000_000
    )
      return false;
    await tx.query(
      sql`INSERT INTO guide_spend(id,account_key,amount_micros) VALUES (${c.token},${key(c.user_id)},${GUIDE_RESERVATION_MICROS})`,
    );
    return true;
  });
}
async function settle(db: StoreDatabase, c: Claim, raw: unknown) {
  const usage = knownUsage(raw);
  if (!usage) return; // Unknown transport/completion retains the full reservation.
  await db.query(
    sql`UPDATE guide_spend SET amount_micros=${cost(usage)},settled=true WHERE id=${c.token} AND NOT settled`,
  );
}
async function finish(
  db: StoreDatabase,
  c: Claim,
  result: { text: string | null } | { reason: string; terminal?: boolean },
) {
  await db.transaction(async (tx) => {
    if ("text" in result) {
      await tx.query(sql`UPDATE report_guides SET guide_text=${result.text},completed_version=${c.source_version},
        status=${result.text === null ? "insufficient" : "ready"},reason=${result.text === null ? "insufficient_evidence" : "completed"}
        WHERE ${fence(c)}`);
    } else {
      await tx.query(sql`UPDATE report_guides SET status=CASE WHEN ${result.terminal ?? false} THEN 'unavailable' WHEN attempts>=2 THEN 'failed' ELSE 'queued' END,
        reason=${result.reason},next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE ${fence(c)}`);
    }
    // Release only our claim. Superseded work must not overwrite the latest status/text.
    await tx.query(sql`UPDATE report_guides SET lease_token=NULL,lease_until=NULL,
      status=CASE WHEN status='running' THEN CASE WHEN attempts>=2 THEN 'failed' ELSE 'queued' END ELSE status END,
      reason=CASE WHEN status='running' THEN 'superseded' ELSE reason END WHERE user_id=${c.user_id} AND report=${c.report} AND lease_token=${c.token}`);
  });
}

/** Finite sequential scheduled run. No writes to originals; no provider calls in saves/reads. */
export async function runGuideWorker(
  db: StoreDatabase,
  provider: GuideProvider,
  options: { maxReports?: number } = {},
) {
  const max = options.maxReports ?? 5;
  if (!Number.isInteger(max) || max < 1 || max > 5)
    throw new Error("Guide worker limit must be 1–5");
  let processed = 0;
  while (processed < max) {
    const c = await claim(db);
    if (!c) break;
    processed++;
    try {
      if (!c.samples.length) {
        await finish(db, c, { text: null });
        continue;
      }
      const request = guideRequest(c.report, c.samples);
      if (
        new TextEncoder().encode(
          JSON.stringify({ ...request, max_tokens: MAX_OUTPUT_TOKENS }),
        ).length > MAX_INPUT_BYTES
      ) {
        await finish(db, c, { reason: "input_too_large", terminal: true });
        continue;
      }
      if (!(await valid(db, c))) {
        await finish(db, c, { reason: "superseded" });
        continue;
      }
      const signal = AbortSignal.timeout(90_000);
      const tokens = await provider.count(request, signal);
      if (!Number.isInteger(tokens) || tokens <= 0)
        throw new Error("Invalid token count");
      if (tokens > MAX_INPUT_TOKENS) {
        await finish(db, c, { reason: "input_too_large", terminal: true });
        continue;
      }
      if (!(await valid(db, c))) {
        await finish(db, c, { reason: "superseded" });
        continue;
      }
      if (!(await reserve(db, c))) {
        await finish(db, c, { reason: "budget_limit", terminal: true });
        continue;
      }
      // Recheck after reservation: loss of eligibility never permits a new provider request.
      if (!(await valid(db, c))) {
        await settle(db, c, { usage: { input_tokens: 0, output_tokens: 0 } });
        await finish(db, c, { reason: "superseded" });
        continue;
      }
      const raw = await provider.generate(request, signal);
      await settle(db, c, raw);
      const result = validateGuide(raw, c.samples);
      await finish(db, c, result);
    } catch {
      // Provider text/errors may contain reference data or secrets: never log them.
      await finish(db, c, { reason: "provider_or_output_failed" });
    }
  }
  return processed;
}
