import { sql } from "drizzle-orm";
import type { StoreDatabase, StoreSession } from "./database";
import { StoreError } from "./errors";

export type ClaimClock = { at: string; day: string };
export type MemoUpdateState = "none" | "held" | "charged" | "released";
export type MemoUpdate = {
  charged: 0 | 1;
  state: MemoUpdateState;
  day_utc: string | null;
  replayed: boolean;
};
export type MemoUpdates = {
  limit: number;
  used: number;
  pending: number;
  available: number;
  resets_at: string;
  as_of: string;
};
export type UpdateReceipt = {
  memo_update_state: MemoUpdateState;
  memo_update_day: string | null;
  memo_updates_enabled: boolean;
};

// Call only after the account lock. A materialized expression evaluates the DB clock once.
export async function claimClock(tx: StoreSession): Promise<ClaimClock> {
  return (
    await tx.query<ClaimClock>(sql`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
    (at AT TIME ZONE 'UTC')::date::text AS day FROM stamp`)
  )[0]!;
}

async function usage(
  tx: StoreSession,
  userId: string,
  limit: number,
  clock: ClaimClock,
): Promise<MemoUpdates> {
  const row = (
    await tx.query<{
      used: number;
      pending: number;
      resets_at: string;
    }>(sql`SELECT
    count(*) FILTER(WHERE memo_update_state='charged')::int AS used,
    count(*) FILTER(WHERE memo_update_state='held' AND NOT completed AND deadline>${clock.at}::timestamptz)::int AS pending,
    to_char((${clock.day}::date+1)::timestamp,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS resets_at
    FROM save_requests WHERE user_id=${userId} AND memo_update_day=${clock.day}::date
    AND memo_update_state IN ('charged','held')`)
  )[0]!;
  return {
    limit,
    ...row,
    available: Math.max(0, limit - row.used - row.pending),
    as_of: clock.at,
  };
}

// Call under the account lock. A plain read: saves take no lock on store_config.
export async function admitMemoUpdate(
  tx: StoreSession,
  userId: string,
  clock: ClaimClock,
) {
  const policy = (
    await tx.query<{
      memo_updates_enabled: boolean;
      memo_updates_daily_limit: number;
    }>(sql`SELECT memo_updates_enabled,memo_updates_daily_limit
    FROM store_config WHERE singleton=1`)
  )[0];
  if (!policy)
    throw new StoreError(
      "configuration",
      "The memo store configuration is missing.",
    );
  if (!policy.memo_updates_enabled) return null;
  const balance = await usage(
    tx,
    userId,
    policy.memo_updates_daily_limit,
    clock,
  );
  if (!balance.available) {
    const pending = balance.used < balance.limit;
    throw new StoreError(
      pending ? "memo_updates_pending" : "memo_updates_exhausted",
      pending
        ? "Today's remaining memo updates are in progress. Retry shortly. Nothing was changed. You can still read and download your cover sheet and reports."
        : `You've used today's ${balance.limit} memo updates. You can still read and download your cover sheet and reports. Updates reset at ${balance.resets_at}. Nothing was changed.`,
      429,
      {
        resets_at: balance.resets_at,
        ...(pending ? { retry_after_seconds: 40 } : {}),
      },
    );
  }
  return clock.day;
}

export function withMemoUpdate<T extends object>(
  result: T,
  receipt: UpdateReceipt,
  replayed = false,
): T & { memo_update?: MemoUpdate } {
  const update: MemoUpdate | undefined =
    receipt.memo_update_state === "none" && !receipt.memo_updates_enabled
      ? undefined
      : {
          state: receipt.memo_update_state,
          charged: receipt.memo_update_state === "charged" ? 1 : 0,
          day_utc: receipt.memo_update_day,
          replayed,
        };
  return { ...result, ...(update ? { memo_update: update } : {}) };
}

// Observational only. Connection acquisition and queries may fail or run slowly;
// neither can change a committed result. Late work checks its deadline as well.
export async function advisory<T>(
  read: () => Promise<T>,
  milliseconds = 250,
): Promise<T | undefined> {
  let cancel = () => {};
  try {
    return await Promise.race([
      Promise.resolve()
        .then(read)
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        cancel = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancel();
  }
}

export async function memoUpdates(db: StoreDatabase, userId: string) {
  const deadline = Date.now() + 250;
  return advisory(() =>
    db.withConnection((connection) =>
      connection.transaction(async (tx) => {
        if (Date.now() >= deadline) return undefined;
        await tx.query(
          sql`SELECT set_config('lock_timeout','100ms',true),set_config('statement_timeout','150ms',true)`,
        );
        const row = (
          await tx.query<{
            enabled: boolean;
            limit: number;
          }>(sql`SELECT memo_updates_enabled AS enabled,memo_updates_daily_limit AS limit
      FROM store_config WHERE singleton=1 AND EXISTS(SELECT 1 FROM users WHERE id=${userId} AND status='active')`)
        )[0];
        if (!row?.enabled || Date.now() >= deadline) return undefined;
        return usage(tx, userId, row.limit, await claimClock(tx));
      }),
    ),
  );
}
