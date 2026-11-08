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
// round trip before its own.
const BATCH = 50;
const writers = new Map<unknown, { queue: Waiting[] }>();

const append = (db: StoreDatabase, rows: Waiting["row"][]) =>
  db.query(sql`INSERT INTO usage_calls (user_id,at,tool)
    SELECT r.user_id, r.at, r.tool
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS r(user_id text, at timestamptz, tool text)
    WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)`);

/**
 * Appends one usage row for a call as it is admitted, alongside the call's own
 * work; the returned promise settles when the row commits or fails, and never
 * rejects. Each process runs at most one writer per database, so usage holds
 * at most one pooled connection: an idle writer sends at once, and rows that
 * arrive meanwhile go in its next batch. The row takes no lock beyond its
 * foreign key's key-share check of the account row, which only a sign-in's or
 * a deletion's lock delays; once an account is erased its row fails that
 * check, and the batch's other rows are retried alone. Failures are logged by
 * class and code only.
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
          try {
            await append(
              target,
              batch.map((w) => w.row),
            );
          } catch (error) {
            logUnexpected("usage", error);
            if (batch.length > 1)
              for (const waiting of batch)
                await append(target, [waiting.row]).catch((single) =>
                  logUnexpected("usage", single),
                );
          }
          for (const waiting of batch) waiting.done();
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
