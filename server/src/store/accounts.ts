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
 * row lock every writer takes, held until the transaction ends. It is FOR NO
 * KEY UPDATE: writers never change users.id, and they still serialize with
 * each other and with every FOR UPDATE (sign-in, account lifecycle, deletion),
 * but a foreign-key check (a usage append's) does not wait on them. */
export async function requireActiveAccount(
  db: StoreSession,
  userId: string,
  { lock }: { lock: boolean },
): Promise<void> {
  const rows = await db.query(
    lock
      ? sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR NO KEY UPDATE`
      : sql`SELECT id FROM users WHERE id=${userId} AND status='active'`,
  );
  if (!rows.length) throw accountUnavailable();
}
