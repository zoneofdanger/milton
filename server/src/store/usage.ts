import { sql } from "drizzle-orm";
import { inBackground, type StoreDatabase } from "./database";
import { logUnexpected } from "../error-log";

export type ToolName =
  "get_cover_sheet" | "get_report" | "list_reports" | "create_memo";
/** One tool call's usage: its tool, and once admitted, its row's append. */
export type CallUsage = { tool: ToolName; recorded?: Promise<void> };

/** How long a reply waits for its call's usage row. A warm append is one
 * single-row statement that runs alongside the call's own work and ends before
 * it; a cold pool checkout (TLS and SCRAM) takes tens of milliseconds more.
 * 250 ms covers both and bounds the worst case (a slow database, or an append
 * waiting on a sign-in's or a deletion's row lock); past it the reply goes and
 * the row finishes in the background. */
export const USAGE_WAIT_MS = 250;

type Waiting = {
  row: { user_id: string; at: string; tool: ToolName };
  done: () => void;
};
// Each database's one writer and the rows waiting for it. Bounded, so a slow
// database costs dropped records, never memory.
const MAX_WAITING = 1000;
// Small, so a row that arrives while a batch is in flight waits about one
// batch before its own.
const BATCH = 50;
const writers = new Map<unknown, { queue: Waiting[] }>();

/** How long one account's insert may wait for its account row (its foreign
 * key's key share). Only a FOR UPDATE holder makes it wait: a sign-in,
 * eligibility or lifecycle transaction, which holds it for milliseconds, or a
 * deletion's erase. One second lets the first kind pass and gives up on a
 * deletion that is still running, dropping that account's rows, so the queue
 * behind it waits at most a second instead of the role's 10 s. */
export const USAGE_LOCK_TIMEOUT = "1s";

// One account's rows in their own short transaction: it commits, releasing
// that account's key share, before the writer moves on, so a wait on one
// account never holds a lock on another.
const append = (db: StoreDatabase, rows: Waiting["row"][]) =>
  db.transaction(async (tx) => {
    await tx.query(
      sql`SELECT set_config('lock_timeout',${USAGE_LOCK_TIMEOUT},true)`,
    );
    await tx.query(sql`INSERT INTO usage_calls (user_id,at,tool)
      SELECT r.user_id, r.at, r.tool
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS r(user_id text, at timestamptz, tool text)
      WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)`);
  });

/**
 * Appends one usage row for a call as it is admitted, alongside the call's own
 * work; the returned promise settles when the row commits or fails, and never
 * rejects. Each process runs at most one writer per database, so usage holds
 * at most one pooled connection: an idle writer sends at once, and rows that
 * arrive meanwhile go in its next batch, one short transaction per account.
 * The row takes no lock beyond its foreign key's key share of its own account
 * row, which only a FOR UPDATE holder (sign-in, eligibility, lifecycle,
 * deletion) delays, for at most USAGE_LOCK_TIMEOUT; once an account is erased
 * its rows fail that check. Either way only that account's rows are dropped.
 * Failures are logged by class and code only.
 */
export function recordToolUsage(
  key: unknown,
  db: () => StoreDatabase,
  userId: string,
  tool: ToolName,
): Promise<void> {
  return new Promise((done) => {
    const row = { user_id: userId, at: new Date().toISOString(), tool };
    const running = writers.get(key);
    if (running) {
      if (running.queue.length < MAX_WAITING) running.queue.push({ row, done });
      else {
        logUnexpected("usage", { code: "usage_dropped" });
        done();
      }
      return;
    }
    const writer = { queue: [{ row, done }] };
    writers.set(key, writer);
    inBackground(async () => {
      try {
        // Rows admitted in this same turn share the first batch.
        await Promise.resolve();
        const target = db();
        while (writer.queue.length) {
          const batch = writer.queue.splice(0, BATCH);
          const accounts = new Map<string, Waiting[]>();
          for (const waiting of batch)
            accounts.set(waiting.row.user_id, [
              ...(accounts.get(waiting.row.user_id) ?? []),
              waiting,
            ]);
          for (const rows of accounts.values()) {
            // A failure (an erased account's foreign key, a lock timeout
            // behind its deletion) drops only this account's rows.
            await append(
              target,
              rows.map((w) => w.row),
            ).catch((error) => logUnexpected("usage", error));
            for (const waiting of rows) waiting.done();
          }
        }
      } catch (error) {
        logUnexpected("usage", error);
      } finally {
        for (const waiting of writer.queue.splice(0)) waiting.done();
        writers.delete(key);
      }
    });
  });
}

/** Waits for a call's usage row for at most USAGE_WAIT_MS. */
export async function usageWithin(
  usage: CallUsage,
  ms = USAGE_WAIT_MS,
): Promise<void> {
  if (!usage.recorded) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    usage.recorded,
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
  ]);
  clearTimeout(timer);
}
