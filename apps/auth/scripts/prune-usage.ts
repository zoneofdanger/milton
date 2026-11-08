// Usage retention, run only by the owner maintenance job (maintain.ts), never
// on a request path. The 90-day retention lives in public.prune_usage_calls
// (Drizzle 0008), owned by the table owner, so no caller can shorten it; the
// job's role may execute that function and nothing else on usage_calls.

/** Rows per statement. Each batch is one DELETE of the oldest rows past
 * retention (by the `at` index), skipping any row an account erasure has
 * locked, so it holds row locks on at most this many old rows for a few
 * milliseconds. It never touches a row the usage writer or a save is using:
 * they insert new rows and lock users, and a prune locks neither. */
export const USAGE_PRUNE_BATCH = 1000;
/** Batches per run: up to 20,000 rows every 15 minutes (the job's schedule),
 * far above Milton's call volume, so a backlog drains over a few runs while a
 * run stays a few seconds and never overlaps the next. */
export const USAGE_PRUNE_BATCHES = 20;
/** Each batch's statement limit, set on the server: Neon drops the one the
 * job's pool passes at connect, and 007 sets none for the owner delegate. A
 * 1,000-row delete by the index takes milliseconds; 10 s (the pool's own
 * value) stops a pathological one from holding its row locks, which would
 * delay an erasure's cascade, and fails the run so it alerts. */
export const USAGE_PRUNE_STATEMENT_TIMEOUT = "10s";
/** Each batch's lock wait. A prune needs only the row-exclusive table lock,
 * which only DDL (a migration) blocks; rather than queue behind one, the run
 * fails and alerts, and the next run, 15 minutes later, retries. */
export const USAGE_PRUNE_LOCK_TIMEOUT = "2s";

type Query = (
  text: string,
  values: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/** Deletes usage rows past retention in bounded batches; returns how many.
 * `query` must run on one connection. Each batch is its own transaction with
 * one DELETE: SET LOCAL holds its limits for exactly that statement, even
 * through a transaction pooler, and they are read back before it runs. */
export async function pruneUsage(query: Query): Promise<number> {
  let total = 0;
  for (let n = 0; n < USAGE_PRUNE_BATCHES; n++) {
    let removed: number;
    await query("begin", []);
    try {
      await query(
        `set local statement_timeout = '${USAGE_PRUNE_STATEMENT_TIMEOUT}'`,
        [],
      );
      await query(`set local lock_timeout = '${USAGE_PRUNE_LOCK_TIMEOUT}'`, []);
      const limits = (
        await query(
          "select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock",
          [],
        )
      ).rows[0];
      if (
        limits?.statement !== USAGE_PRUNE_STATEMENT_TIMEOUT ||
        limits?.lock !== USAGE_PRUNE_LOCK_TIMEOUT
      )
        throw new Error("usage_prune_timeouts_unset");
      removed = (
        await query("select public.prune_usage_calls($1) as removed", [
          USAGE_PRUNE_BATCH,
        ])
      ).rows[0]!.removed as number;
      await query("commit", []);
    } catch (error) {
      await query("rollback", []).catch(() => {});
      throw error;
    }
    total += removed;
    if (removed < USAGE_PRUNE_BATCH) break;
  }
  return total;
}
