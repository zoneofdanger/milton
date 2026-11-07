import { sql } from "drizzle-orm";
import { inBackground, type StoreDatabase } from "./database";
import { logUnexpected } from "../error-log";

/** One admitted tool call, as its log line names it. */
export type ToolUsage = {
  tool: "get_cover_sheet" | "get_report" | "list_reports" | "create_memo";
  outcome: "read" | "saved" | "unchanged" | "conflict" | "refused" | "failed";
};
type Row = ToolUsage & { user_id: string; at: string };

// Rows waiting for their database's one writer, by database. Bounded, so a slow
// database costs dropped records, never memory or a request's time.
const MAX_WAITING = 1000;
const BATCH = 500;
const waiting = new Map<unknown, Row[]>();

/**
 * Appends one usage row for an admitted call, after its response: nothing
 * awaits it, it takes no lock (no foreign key, so no lock on the account row)
 * and it reads nothing back. Each process runs at most one writer per
 * database, so usage never holds more than one pooled connection; calls that
 * arrive while it runs join its next batch. A failure loses those rows and is
 * logged by class and code only. A row is written only while its account
 * exists; account erasure deletes the account's rows.
 */
export function recordToolUsage(
  key: unknown,
  db: () => StoreDatabase,
  userId: string,
  usage: ToolUsage,
): void {
  const row: Row = {
    user_id: userId,
    at: new Date().toISOString(),
    tool: usage.tool,
    outcome: usage.outcome,
  };
  const queued = waiting.get(key);
  if (queued) {
    if (queued.length < MAX_WAITING) queued.push(row);
    else logUnexpected("usage", { code: "usage_dropped" });
    return;
  }
  const rows = [row];
  waiting.set(key, rows);
  inBackground(async () => {
    try {
      // Let the response that produced this row go out first.
      await new Promise((resolve) => setImmediate(resolve));
      const target = db();
      while (rows.length) {
        const batch = rows.splice(0, BATCH);
        try {
          await target.query(sql`INSERT INTO usage_calls (user_id,at,tool,outcome)
            SELECT r.user_id, r.at, r.tool, r.outcome
            FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
              AS r(user_id text, at timestamptz, tool text, outcome text)
            WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)`);
        } catch (error) {
          logUnexpected("usage", error);
        }
      }
    } catch (error) {
      logUnexpected("usage", error);
    } finally {
      waiting.delete(key);
    }
  });
}
