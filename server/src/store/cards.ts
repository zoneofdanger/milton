import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Filing } from "./reports";

export type CardHead = {
  id: string;
  version: number;
  description: string;
  body: string;
  archived: boolean;
  /** Where the head version files this rule: a report, or 'cover' for the
   * cover sheet. Moving a rule appends a version. */
  report: Filing;
};
// Cards are read in their write-once insertion position (backfilled in card ID
// order by 0016); a moved card keeps its position. Report lives on the version
// (0020), so the fingerprint below fences every card input to assembly.
/** Every card's head version as one JSON array, so a read can take the heads
 * and the samples in a single statement. */
export const cardHeadsJson = (userId: string) =>
  sql`SELECT coalesce(json_agg(json_build_object('id',c.id,'version',v.version,'description',v.description,'body',v.body,'archived',v.archived,'report',v.report) ORDER BY c.position),'[]'::json)
    FROM instruction_cards c
    JOIN LATERAL (SELECT version,description,body,archived,report FROM instruction_card_versions WHERE user_id=c.user_id AND card_id=c.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE c.user_id=${userId}`;
export const cardFingerprint = (heads: CardHead[]) =>
  createHash("sha256")
    .update(JSON.stringify(heads.map((h) => [h.id, h.version, h.archived])))
    .digest("hex");
/** A Markdown ATX heading line. Card text may not contain one; Milton prints
 * each report's heading itself. */
export const headingLine = /^ {0,3}#{1,6}(?:[ \t]|$)/m;
