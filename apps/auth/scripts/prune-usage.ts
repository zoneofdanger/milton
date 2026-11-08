// Usage retention, run only by the owner maintenance job (maintain.ts), never
// on a request path. The 90-day retention lives in public.prune_usage_calls
// (Drizzle 0008), owned by the table owner, so no caller can shorten it; the
// job's role may execute that function and nothing else on usage_calls.

/** Rows per statement. Each batch is one autocommit DELETE of the oldest rows
 * past retention (by the `at` index), skipping any row an account erasure has
 * locked, so it holds row locks on at most this many old rows for a few
 * milliseconds, well inside the job's 10 s statement limit. It never touches a
 * row the usage writer or a save is using: they insert new rows and lock users,
 * and a prune locks neither. */
export const USAGE_PRUNE_BATCH = 1000;
/** Batches per run: up to 20,000 rows every 15 minutes (the job's schedule),
 * far above Milton's call volume, so a backlog drains over a few runs while a
 * run stays a few seconds and never overlaps the next. */
export const USAGE_PRUNE_BATCHES = 20;

type Query = (
  text: string,
  values: unknown[],
) => Promise<{ rows: { removed: number }[] }>;

/** Deletes usage rows past retention in bounded batches; returns how many. */
export async function pruneUsage(query: Query): Promise<number> {
  let total = 0;
  for (let n = 0; n < USAGE_PRUNE_BATCHES; n++) {
    const removed = (
      await query("select public.prune_usage_calls($1) as removed", [
        USAGE_PRUNE_BATCH,
      ])
    ).rows[0]!.removed;
    total += removed;
    if (removed < USAGE_PRUNE_BATCH) break;
  }
  return total;
}
