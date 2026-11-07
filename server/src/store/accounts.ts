import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";
import { StoreError } from "./errors";

/** The refusal for an account that is closed or does not exist. */
export const accountUnavailable = () =>
  new StoreError(
    "account_unavailable",
    "This Milton account is unavailable.",
    403,
  );

/** Refuses unless the account is active. With `lock`, also takes the account
 * row lock every writer takes, held until the transaction ends. */
export async function requireActiveAccount(
  db: StoreSession,
  userId: string,
  { lock }: { lock: boolean },
): Promise<void> {
  const rows = await db.query(
    lock
      ? sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`
      : sql`SELECT id FROM users WHERE id=${userId} AND status='active'`,
  );
  if (!rows.length) throw accountUnavailable();
}
