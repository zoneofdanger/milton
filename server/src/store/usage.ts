import { sql } from "drizzle-orm";
import { inBackground, type StoreDatabase } from "./database";
import { logUnexpected } from "../error-log";

export type ToolName = "get_report" | "create_memo";
/** One tool call's usage: its tool, and once admitted, its row's append. */
export type CallUsage = { tool: ToolName; recorded?: Promise<void> };

/** How long a reply waits for its call's usage row. A warm append is one
 * statement that runs alongside the call's own work and ends before it; a
 * cold pool checkout (TLS and SCRAM) takes tens of milliseconds more. 250 ms
 * covers both and bounds the worst case (a slow database, or a row waiting
 * for its retry); past it the reply goes and the row finishes in the
 * background. */
export const USAGE_WAIT_MS = 250;
/** How long each row skipped behind its account's FOR UPDATE waits, from its
 * own skip, for its one retry. Sign-in and eligibility hold that lock for milliseconds; a deletion
 * holds it until the account is gone, and its rows then drop. */
export const USAGE_RETRY_MS = 50;

type Waiting = {
  row: { user_id: string; at: string; tool: ToolName };
  done: () => void;
  /** When a skipped row may retry. */
  retryAt?: number;
};
// Retries are in skip order, so their retry times only increase. `wake`
// ends a wait for the next retry when a new row arrives.
type Writer = { queue: Waiting[]; retry: Waiting[]; wake?: () => void };
// Each database's one writer and the rows waiting for it. Bounded, so a slow
// database costs dropped records, never memory.
const MAX_WAITING = 1000;
// Small, so a row that arrives while a batch is in flight waits about one
// statement before its own.
const BATCH = 50;
const writers = new Map<unknown, Writer>();

/** One batch in one autocommit statement that never waits on an account row
 * lock: it takes the key share of each batch account it can lock now (SKIP
 * LOCKED), so its foreign-key checks find that lock already held, and inserts
 * only those accounts' rows. Only a FOR UPDATE holder (sign-in, eligibility,
 * lifecycle, deletion) makes an account skip; a writer's FOR NO KEY UPDATE
 * does not. SKIP LOCKED covers row locks only: a migration holding a table
 * lock on usage_calls or users can still delay it (as it would requests), up
 * to the role's lock timeout, while each call's wait stays capped at
 * USAGE_WAIT_MS. Returns the accounts it wrote. */
async function append(db: StoreDatabase, rows: Waiting["row"][]) {
  const written = await db.query<{ id: string }>(sql`WITH r AS (
      SELECT * FROM unnest(${sql.param(rows.map((r) => r.user_id))}::text[],
        ${sql.param(rows.map((r) => r.at))}::timestamptz[],
        ${sql.param(rows.map((r) => r.tool))}::text[]) AS r(user_id,at,tool)),
    locked AS MATERIALIZED (
      SELECT id FROM users WHERE id IN (SELECT user_id FROM r)
      FOR KEY SHARE SKIP LOCKED),
    inserted AS (
      INSERT INTO usage_calls (user_id,at,tool)
      SELECT r.user_id, r.at, r.tool FROM r JOIN locked ON locked.id = r.user_id)
    SELECT id FROM locked`);
  return new Set(written.map((w) => w.id));
}

/**
 * Appends one usage row for a call as it is admitted, alongside the call's own
 * work; the returned promise settles when the row commits or is dropped, and
 * never rejects. Each process runs at most one writer per database, so usage
 * holds at most one pooled connection: an idle writer sends at once, and rows
 * that arrive meanwhile go in its next batch. A statement holds key shares
 * only on the accounts it inserts, only while it runs, and never waits on an
 * account row lock. A row skipped behind its account's FOR UPDATE is retried
 * once, USAGE_RETRY_MS after its own skip, then dropped (an erased account's
 * rows drop this way).
 * Failures and drops are logged by class and code only.
 */
export function recordToolUsage(
  key: unknown,
  db: () => StoreDatabase,
  userId: string,
  tool: ToolName,
): Promise<void> {
  return new Promise((done) => {
    const waiting = {
      row: { user_id: userId, at: new Date().toISOString(), tool },
      done,
    };
    const running = writers.get(key);
    if (running) {
      if (running.queue.length + running.retry.length < MAX_WAITING) {
        running.queue.push(waiting);
        running.wake?.();
      } else {
        logUnexpected("usage", { code: "usage_dropped" });
        done();
      }
      return;
    }
    const writer: Writer = { queue: [waiting], retry: [] };
    writers.set(key, writer);
    inBackground(async () => {
      try {
        // Rows admitted in this same turn share the first batch.
        await Promise.resolve();
        const target = db();
        while (writer.queue.length || writer.retry.length) {
          const wait = writer.queue.length
            ? 0
            : writer.retry[0]!.retryAt! - Date.now();
          if (wait > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, wait);
              writer.wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            writer.wake = undefined;
          }
          const now = Date.now();
          let due = 0;
          while (
            due < writer.retry.length &&
            due < BATCH &&
            writer.retry[due]!.retryAt! <= now
          )
            due++;
          const batch = writer.retry.splice(0, due);
          batch.push(...writer.queue.splice(0, BATCH - batch.length));
          if (!batch.length) continue;
          let written: Set<string>;
          try {
            written = await append(
              target,
              batch.map((w) => w.row),
            );
          } catch (error) {
            logUnexpected("usage", error);
            for (const w of batch) w.done();
            continue;
          }
          let skipped = 0;
          for (const w of batch)
            if (written.has(w.row.user_id)) w.done();
            else if (w.retryAt === undefined) {
              w.retryAt = Date.now() + USAGE_RETRY_MS;
              writer.retry.push(w);
            } else {
              skipped++;
              w.done();
            }
          if (skipped) logUnexpected("usage", { code: "usage_skipped" });
        }
      } catch (error) {
        logUnexpected("usage", error);
      } finally {
        for (const w of [...writer.queue, ...writer.retry]) w.done();
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
