import { z } from "zod";
import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";
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
  return parseLimits(
    (
      await db.query<{ limits_json: unknown }>(
        sql`SELECT limits_json FROM store_config WHERE singleton = 1`,
      )
    )[0]?.limits_json,
  );
}
/** `store_config.limits_json` as read, or the refusal for invalid limits. */
export function parseLimits(value: unknown): StoreLimits {
  const result = limitsSchema.safeParse(value);
  if (!result.success)
    throw new StoreError("configuration", "The memo store limits are invalid.");
  return result.data;
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).length;
/** The bound on each assembled body, in UTF-8 bytes (utf8Bytes): saves refuse
 * past it, and an intent read selects its samples within it. */
export const reportCap = (limits: StoreLimits) =>
  Math.min(limits.report_body_bytes, 262144);
