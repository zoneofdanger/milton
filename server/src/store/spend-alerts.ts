import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { StoreDatabase, StoreSession } from "./database";
import { StoreError } from "./errors";
import { lockSpendPolicy } from "./spend-policy";

export const spendAlertThresholds = [100, 250, 500, 1000].map(
  (n) => n * 1_000_000,
);
export function configuredAlertThresholds(value?: string) {
  if (value === undefined) return spendAlertThresholds;
  const thresholds = value.split(",").map((raw) => {
    if (!/^\d+(?:\.\d{1,6})?$/.test(raw))
      throw new StoreError("configuration", "Invalid alert threshold.");
    const [dollars, fraction = ""] = raw.split(".");
    const amount =
      BigInt(dollars!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    if (amount < 1n || amount > BigInt(Number.MAX_SAFE_INTEGER))
      throw new StoreError("configuration", "Invalid alert threshold.");
    return Number(amount);
  });
  if (
    !thresholds.length ||
    thresholds.length > 16 ||
    thresholds.some((n, i) => i > 0 && n <= thresholds[i - 1]!)
  )
    throw new StoreError(
      "configuration",
      "Alert thresholds must increase, with at most 16 levels.",
    );
  return thresholds;
}

// Scheduled observation only. No request or provider-dispatch path calls this.
// Publication itself is a DB transaction, so an unknown acknowledgment can replay
// the unique keys without an external-delivery ambiguity or a second event.
export async function observeSpendAlerts(
  db: StoreDatabase,
  thresholds = spendAlertThresholds,
) {
  if (
    !thresholds.length ||
    thresholds.length > 16 ||
    thresholds.some(
      (n, i) =>
        !Number.isSafeInteger(n) ||
        n <= 0 ||
        (i > 0 && n <= thresholds[i - 1]!),
    )
  )
    throw new StoreError("configuration", "Invalid reservation alert ladder.");
  return db.transaction(async (tx) => {
    await tx.query(
      sql`SELECT set_config('lock_timeout','250ms',true),set_config('statement_timeout','1000ms',true)`,
    );
    const policy = await lockSpendPolicy(tx);
    if (policy.global_spend_policy !== "alerts_only")
      return { status: "disabled", published: 0 };
    const days = await tx.query<{
      day: string;
      filing: string;
      review: string;
      derived: string;
    }>(sql`SELECT day_utc::text AS day,
      sum(filing)::text AS filing,sum(review)::text AS review,sum(derived)::text AS derived FROM (
        SELECT day_utc,reserved_micros AS filing,0::bigint AS review,0::bigint AS derived FROM foreground_usage
        UNION ALL SELECT day_utc,0,reserved_micros,0 FROM gardening_usage
        UNION ALL SELECT day_utc,0,0,reserved_micros FROM derivation_usage
      ) totals WHERE day_utc BETWEEN (clock_timestamp() AT TIME ZONE 'UTC')::date-30 AND (clock_timestamp() AT TIME ZONE 'UTC')::date
      GROUP BY day_utc ORDER BY day_utc LIMIT 31`);
    const rows: SQL[] = [];
    for (const day of days) {
      const total =
        BigInt(day.filing) + BigInt(day.review) + BigInt(day.derived);
      const crossed = thresholds.filter((n) => total >= BigInt(n));
      for (const threshold of crossed) {
        const highest = threshold === crossed.at(-1);
        rows.push(sql`(${randomUUID()},${day.day}::date,'model_reservations',${threshold},${day.filing}::bigint,${day.review}::bigint,${day.derived}::bigint,
          ${highest ? "published" : "covered"},clock_timestamp(),${highest ? sql`clock_timestamp()` : sql`NULL`})`);
      }
    }
    if (!rows.length) return { status: "idle", published: 0 };
    const inserted = await tx.query<{
      status: string;
    }>(sql`INSERT INTO spend_alerts(id,day_utc,metric,threshold_micros,filing_micros,review_micros,derived_micros,status,created_at,published_at)
      VALUES ${sql.join(rows, sql`, `)} ON CONFLICT(day_utc,metric,threshold_micros) DO NOTHING RETURNING status`);
    const published = inserted.filter((r) => r.status === "published").length;
    return { status: published ? "published" : "idle", published };
  });
}

const usd = (micros: string) => {
  const amount = BigInt(micros);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
};
export async function readSpendAlerts(tx: StoreSession) {
  const rows = await tx.query<{
    id: string;
    day_utc: string;
    threshold: string;
    filing: string;
    review: string;
    derived: string;
    observed_at: string;
    published_at: string;
  }>(sql`SELECT id,day_utc::text,
    threshold_micros::text AS threshold,filing_micros::text AS filing,review_micros::text AS review,derived_micros::text AS derived,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
    to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at
    FROM spend_alerts WHERE status='published' AND day_utc BETWEEN (clock_timestamp() AT TIME ZONE 'UTC')::date-30 AND (clock_timestamp() AT TIME ZONE 'UTC')::date
    ORDER BY published_at DESC,id DESC LIMIT 100`);
  return {
    metric: "conservative_model_reservations_usd",
    description:
      "Conservative model reservations, not invoices or memo updates. Published means available in this private feed; it does not confirm a client read or notification.",
    events: rows.map((r) => ({
      id: r.id,
      day_utc: r.day_utc,
      threshold_usd: usd(r.threshold),
      reserved_usd: {
        filing: usd(r.filing),
        review: usd(r.review),
        derived: usd(r.derived),
        total: usd(
          (BigInt(r.filing) + BigInt(r.review) + BigInt(r.derived)).toString(),
        ),
      },
      observed_at: r.observed_at,
      published_at: r.published_at,
    })),
  };
}
