import { sql } from "drizzle-orm";
import type { GlobalSpendPolicy } from "../spend-policy";
import type { StoreSession } from "./database";
import { StoreError } from "./errors";

export type SpendPolicy = {
  global_spend_policy: GlobalSpendPolicy;
  memo_updates_enabled: boolean;
  memo_updates_daily_limit: number;
  foreground_accounting_ready: boolean;
};

// Global before account, on every path that admits paid or user-update work.
export async function lockSpendPolicy(tx: StoreSession): Promise<SpendPolicy> {
  const row = (
    await tx.query<SpendPolicy>(sql`SELECT global_spend_policy,
    memo_updates_enabled,memo_updates_daily_limit,foreground_accounting_ready
    FROM store_config WHERE singleton=1 FOR UPDATE`)
  )[0];
  if (!row || !["capped", "alerts_only"].includes(row.global_spend_policy))
    throw new StoreError("configuration", "Invalid global spending policy.");
  return row;
}
