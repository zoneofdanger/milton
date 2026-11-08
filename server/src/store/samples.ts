import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { StoreSession } from "./database";
import { StoreError } from "./errors";
import { resolveReportId, type Sample } from "./reports";
import type { SaveMemoInput } from "./compiled";

/** Latest complete revisions, including retirement. Filter after choosing heads. */
export const sampleHeads = (userId: string) => sql`
  SELECT DISTINCT ON (v.sample_id) v.*,s.id,s.created_at AS original_created_at
  FROM sample_versions v JOIN samples s ON s.user_id=v.user_id AND s.id=v.sample_id
  WHERE v.user_id=${userId} ORDER BY v.sample_id,v.version DESC`;

/** The account lock and savepoint belong to runSave. All operations use its
 * original snapshot and either commit together with the rules or roll back. */
export async function applySampleChanges(
  tx: StoreSession,
  userId: string,
  input: SaveMemoInput,
  current: { samples: Sample[] },
  attribution: string,
) {
  const conflict = (message: string): never => {
    throw new StoreError(
      "sample_conflict",
      message + " Nothing was changed.",
      409,
    );
  };
  const retiring = new Set(input.retire_samples ?? []);
  if (
    retiring.size !== (input.retire_samples?.length ?? 0) ||
    [...retiring].some((id) => !current.samples.some((s) => s.id === id))
  )
    conflict("Each sample to retire must be an active sample, listed once.");
  // Every new version, in this order, in one statement; the row triggers
  // check each row.
  const versions: {
    sample: Pick<
      Sample,
      "id" | "revision" | "report" | "kind_id" | "context" | "body"
    >;
    retired: boolean;
  }[] = [];
  const append = (
    sample: Pick<
      Sample,
      "id" | "revision" | "report" | "kind_id" | "context" | "body"
    >,
    retired = false,
  ) => {
    versions.push({ sample, retired });
  };
  let changed = false;
  const sample = input.sample;
  const correction = input.sample_context;
  if (sample || correction) {
    const report = resolveReportId((sample ?? correction)!.report)!;
    const id = sample?.sample_id ?? correction?.sample_id;
    const previous = current.samples.find((s) => s.id === id);
    if (
      id !== undefined &&
      (!previous ||
        retiring.has(id) ||
        (correction && previous.report !== report))
    )
      conflict(
        "sample_id must name an active sample; sample_context must also match its report.",
      );
    let kindId = sample?.kind_id ?? correction?.kind_id ?? previous?.kind_id;
    // A full revision supplies its complete classification, including new_kind.
    if (sample?.new_kind !== undefined) kindId = undefined;
    if (kindId === undefined) {
      const label = sample!.new_kind!;
      kindId = (
        await tx.query<{ id: string }>(
          sql`SELECT id FROM sample_kinds WHERE user_id=${userId} AND report=${report} AND lower(label)=lower(${label})`,
        )
      )[0]?.id;
      if (kindId === undefined) {
        kindId = randomUUID();
        await tx.query(
          sql`INSERT INTO sample_kinds(user_id,id,report,label) VALUES (${userId},${kindId},${report},${label})`,
        );
      }
    } else if (
      !(
        await tx.query(
          sql`SELECT 1 FROM sample_kinds WHERE user_id=${userId} AND id=${kindId} AND report=${report}`,
        )
      ).length
    )
      conflict("kind_id must name an existing kind in this report.");
    const context = (sample ?? correction)!.context;
    const body = sample?.text ?? previous!.body;
    // Equality is complete, with JSONB semantics for context object key order.
    // New examples may dedup; revisions only compare against their own identity.
    const identical =
      (
        await tx.query(sql`SELECT 1 FROM (${sampleHeads(userId)}) h
      WHERE NOT h.retired AND h.report=${report} AND h.kind_id=${kindId} AND h.body=${body}
      AND h.context=${JSON.stringify(context)}::jsonb
      AND ${id === undefined ? sql`h.sample_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify([...retiring])}::jsonb))` : sql`h.sample_id=${id}`} LIMIT 1`)
      ).length > 0;
    if (!identical) {
      const stableId = id ?? randomUUID();
      if (id === undefined)
        await tx.query(
          sql`INSERT INTO samples(user_id,id,client_json) VALUES (${userId},${stableId},${attribution})`,
        );
      append({
        id: stableId,
        revision: previous?.revision ?? 0,
        report,
        kind_id: kindId,
        context,
        body,
      });
      changed = true;
    }
  }
  for (const id of retiring)
    append(
      current.samples.find((s) => s.id === id)!,
      true,
    );
  // One array parameter per column, so a save's size never meets the
  // statement's parameter limit.
  if (versions.length)
    await tx.query(sql`INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,retired,retire_reason,actor_json,request_id,created_at)
      SELECT ${userId}::text,v.sample_id,v.version,v.report,v.kind_id,v.context::jsonb,v.body,v.retired,v.retire_reason,${attribution}::text,${input.request_id}::text,clock_timestamp()
      FROM unnest(${sql.param(versions.map((v) => v.sample.id))}::text[],
        ${sql.param(versions.map((v) => v.sample.revision + 1))}::int[],
        ${sql.param(versions.map((v) => v.sample.report))}::text[],
        ${sql.param(versions.map((v) => v.sample.kind_id))}::text[],
        ${sql.param(versions.map((v) => JSON.stringify(v.sample.context)))}::text[],
        ${sql.param(versions.map((v) => v.sample.body))}::text[],
        ${sql.param(versions.map((v) => v.retired))}::boolean[],
        ${sql.param(versions.map((v) => (v.retired ? "removed" : null)))}::text[])
        WITH ORDINALITY AS v(sample_id,version,report,kind_id,context,body,retired,retire_reason,ord)
      ORDER BY v.ord`);
  return {
    changed: changed || retiring.size > 0,
    retired: [...retiring].map((id) => ({ id, reason: "removed" as const })),
  };
}
