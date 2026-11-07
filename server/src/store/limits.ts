import { z } from "zod";
import { sql } from "drizzle-orm";
import { databaseFailure, type StoreSession } from "./database";
import { StoreError } from "./errors";

const positiveLimit = z.number().int().positive();
const limitsSchema = z.object({
  body_bytes: positiveLimit,
  description_bytes: positiveLimit,
  report_body_bytes: positiveLimit,
  daily_calls: positiveLimit,
});
export type StoreLimits = z.infer<typeof limitsSchema>;

export async function readLimits(db: StoreSession): Promise<StoreLimits> {
  let value: unknown;
  try {
    value = (
      await db.query<{ limits_json: unknown }>(
        sql`SELECT limits_json FROM store_config WHERE singleton = 1`,
      )
    )[0]?.limits_json;
  } catch (error) {
    throw databaseFailure(error);
  }
  const result = limitsSchema.safeParse(value);
  if (!result.success)
    throw new StoreError("configuration", "The memo store limits are invalid.");
  return result.data;
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).length;
