import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";
import type { CardHead } from "./cards";

export async function recordAcceptedChange(
  tx: StoreSession,
  input: {
    userId: string;
    requestId: string;
    operation: "save_memo";
    request: unknown;
    actor: unknown;
    transformation: unknown;
    before: CardHead[];
    after: CardHead[];
    beforeTps: string;
    afterTps: string;
    beforeSource: string;
    afterSource: string;
  },
) {
  const old = new Map(input.before.map((c) => [c.id, c.version]));
  const affected = input.after
    .filter((c) => old.get(c.id) !== c.version)
    .map((c) => ({
      id: c.id,
      before: old.get(c.id) ?? null,
      after: c.version,
    }));
  await tx.query(sql`INSERT INTO accepted_changes(user_id,request_id,operation,request_json,actor_json,transformation_json,affected_json,before_tps,after_tps,before_source,after_source)
    VALUES (${input.userId},${input.requestId},${input.operation},${JSON.stringify(input.request)}::jsonb,${JSON.stringify(input.actor)}::jsonb,${JSON.stringify(input.transformation)}::jsonb,${JSON.stringify(affected)}::jsonb,${input.beforeTps},${input.afterTps},${input.beforeSource},${input.afterSource})`);
  return affected.length > 0;
}
