import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { headingLine, type CardHead } from "./cards";
import type { StoreSession } from "./database";
import { bullet, resolveReportId, FILINGS } from "./reports";
import { StoreError } from "./errors";
import { utf8Bytes, type readLimits } from "./index";
import { exactEditsProposal, exactMoves } from "../exact-edits";
import { publishSave } from "./save-publish";
import { closestBaseline, knownBaseline } from "./setup";
import {
  retiredSample,
  type SaveContext,
  type SaveOutcome,
  type Snapshot,
} from "./save-context";

type Head = CardHead;

/** A card's description, derived without a model: the first non-blank line,
 * trimmed and cut to fit the byte cap. Descriptions are never printed. */
function describe(body: string, maxBytes: number) {
  const line =
    body
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  if (utf8Bytes(line) <= maxBytes) return line;
  let cut = "";
  for (const char of line) {
    if (utf8Bytes(cut + char + "…") > maxBytes) break;
    cut += char;
  }
  return cut.trimEnd() + "…";
}

/** Validate and apply, inside the save's transaction: resolve the exact edits
 * and moves against the locked snapshot, refuse collisions and limit breaches,
 * then write every card and sample change and publish. */
export async function applySave(
  ctx: SaveContext,
  tx: StoreSession,
  current: Snapshot,
  limits: Awaited<ReturnType<typeof readLimits>>,
): Promise<SaveOutcome> {
  const { userId, actor, input, result } = ctx;
  // Every anchor resolves against the locked snapshot.
  const cards = current.active.map((h) => ({
    id: h.id,
    description: h.description,
    text: h.body,
  }));
  const { updates, retire } = exactEditsProposal(
    cards,
    input.exact_edits ?? [],
  );
  const moves = exactMoves(
    cards,
    (input.moves ?? []).map((m) => ({
      before: m.before,
      report: m.report === "doc" ? "document" : m.report,
    })),
  );
  // The active rules as this save leaves them: edits, removals and moves
  // applied. A changed rule may not end up printing identically to another
  // in its report, because neither could then be targeted; an untouched
  // identical pair does not block the save. Rules compare as printed, so a
  // bare rule and its compiler-era "- " twin are the same rule.
  const retiring = new Set(retire);
  const edited = new Map(updates.map((u) => [u.id, u.text]));
  const movedTo = new Map(moves.map((m) => [m.id, m.report]));
  const key = (report: string, body: string) =>
    JSON.stringify([report, bullet(body)]);
  const after = current.active
    .filter((h) => !retiring.has(h.id))
    .map((h) => {
      const report = movedTo.get(h.id) ?? h.report;
      const body = edited.get(h.id) ?? h.body;
      return {
        report,
        body,
        key: key(report, body),
        changed: report !== h.report || body !== h.body,
      };
    });
  const counts = new Map<string, number>();
  for (const card of after)
    counts.set(card.key, (counts.get(card.key) ?? 0) + 1);
  const collision = after.find(
    (card) => card.changed && counts.get(card.key)! > 1,
  );
  if (collision)
    throw new StoreError(
      "edit_conflict",
      `This save would leave two identical rules in ${collision.report === "cover" ? "the cover sheet" : `the ${collision.report} report`}: "${describe(collision.body, 120)}". Change the wording or remove one of them. Nothing was changed.`,
      409,
    );
  // A rule that prints like a rule in the same report after this save, or
  // an earlier entry in this request, is skipped.
  const onFile = new Set(after.map((card) => card.key));
  const creates: { report: (typeof FILINGS)[number]; text: string }[] = [];
  for (const rule of input.rules ?? []) {
    const report = rule.report === "doc" ? "document" : rule.report;
    const printed = key(report, rule.text);
    if (onFile.has(printed)) continue;
    onFile.add(printed);
    creates.push({ report, text: rule.text });
  }
  // A rule stored with the setup prefix must be a setup rule byte for byte,
  // in the report it is served for, whether filed new or changed by an exact
  // edit or a move.
  const unknown = [
    ...creates,
    ...after
      .filter((card) => card.changed)
      .map((card) => ({ report: card.report, text: card.body })),
  ].find((rule) => !knownBaseline(rule.text, rule.report));
  if (unknown !== undefined) {
    const closest = closestBaseline(unknown.text);
    throw new StoreError(
      "baseline_unknown",
      `"${describe(unknown.text, 120)}" in ${unknown.report} starts with "Baseline: " but is not a setup rule for that report. Copy the rule and its report exactly from the setup text, or send a rule in the person's own words without "Baseline: ". Closest setup rule: [${closest.report}] "${closest.text}". Nothing was changed.`,
      422,
    );
  }
  const attribution = JSON.stringify({
    kind: "assistant",
    issuer: actor.issuer,
    client_id: actor.clientId,
  });
  const sampleConflict = (message: string) =>
    new StoreError("sample_conflict", message + " Nothing was changed.", 409);
  // Structured saves change samples and cards together, or not at all.
  const retired: z.infer<typeof retiredSample>[] = [];
  const retireSample = async (
    id: string,
    reason: "replaced" | "removed",
    kindId?: string,
  ) =>
    (
      await tx.query(sql`UPDATE samples SET retired_at=clock_timestamp(),retire_reason=${reason},retired_request_id=${input.request_id}
          WHERE user_id=${userId} AND id=${id} AND retired_at IS NULL ${kindId === undefined ? sql`` : sql`AND kind_id=${kindId}`} RETURNING id`)
    ).length > 0;
  // A sample whose bytes equal an active sample of its kind files nothing:
  // no copy. A replacement of some other sample still applies.
  // Samples this save retires are not on file for this check.
  const sampleReport = input.sample && resolveReportId(input.sample.report)!;
  const duplicate =
    input.sample &&
    (
      await tx.query<{ id: string }>(sql`SELECT s.id FROM samples s
          JOIN sample_kinds k ON k.user_id=s.user_id AND k.id=s.kind_id
          WHERE s.user_id=${userId} AND s.report=${sampleReport} AND s.retired_at IS NULL AND s.body=${input.sample.text}
          AND s.id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.retire_samples ?? [])}::jsonb))
          AND ${input.sample.kind_id === undefined ? sql`lower(k.label)=lower(${input.sample.new_kind!})` : sql`k.id=${input.sample.kind_id}`}
          LIMIT 1`)
    )[0]?.id;
  const sampleSkipped =
    duplicate !== undefined &&
    (input.sample!.replaces === undefined ||
      input.sample!.replaces === duplicate);
  const applySamples = async () => {
    for (const id of input.retire_samples ?? []) {
      if (!(await retireSample(id, "removed")))
        throw sampleConflict(
          "Each sample to retire must be an active sample, listed once.",
        );
      retired.push({ id, reason: "removed" });
    }
    const sample = input.sample;
    if (!sample || sampleSkipped) return;
    const report = sampleReport!;
    let kindId = sample.kind_id;
    if (kindId === undefined) {
      // A label already used in this report, in any letter case, is
      // that kind, even when none of its samples is still listed.
      kindId = (
        await tx.query<{ id: string }>(
          sql`SELECT id FROM sample_kinds WHERE user_id=${userId} AND report=${report} AND lower(label)=lower(${sample.new_kind!})`,
        )
      )[0]?.id;
      if (kindId === undefined) {
        kindId = randomUUID();
        await tx.query(
          sql`INSERT INTO sample_kinds(user_id,id,report,label) VALUES (${userId},${kindId},${report},${sample.new_kind!})`,
        );
      }
    } else if (
      !(
        await tx.query(
          sql`SELECT 1 FROM sample_kinds WHERE user_id=${userId} AND id=${kindId} AND report=${report}`,
        )
      ).length
    )
      throw sampleConflict(
        "kind_id must name an existing kind in this report.",
      );
    if (sample.replaces !== undefined) {
      if (!(await retireSample(sample.replaces, "replaced", kindId)))
        throw sampleConflict(
          "replaces must name an active sample of the same kind.",
        );
      retired.push({ id: sample.replaces, reason: "replaced" });
    }
    if (duplicate !== undefined) return;
    // Every approved sample stays until the person retires or replaces it.
    await tx.query(sql`INSERT INTO samples(user_id,id,report,kind_id,context,body,client_json,replaces_id,audience,purpose,register)
        VALUES (${userId},${randomUUID()},${report},${kindId},${sample.context},${sample.text},${attribution},${sample.replaces ?? null},${sample.audience ?? null},${sample.purpose ?? null},${sample.register ?? null})`);
  };
  const known = new Map(current.active.map((h) => [h.id, h]));
  // A rule cannot be moved and retired at once, including by an exact
  // edit that empties it.
  if (moves.some((m) => retire.includes(m.id)))
    throw new StoreError(
      "move_conflict",
      "A rule this save removes cannot also move. Nothing was changed.",
      409,
    );
  if (
    [...updates, ...creates].some((m) => utf8Bytes(m.text) > limits.body_bytes)
  )
    throw new StoreError(
      "memo_body_limit",
      "A rule exceeds its size limit. Nothing was changed.",
      422,
    );
  // Milton prints each report's heading; one inside card text would repeat.
  if (
    creates.some((m) => headingLine.test(m.text)) ||
    updates.some(
      (m) => known.get(m.id)?.body !== m.text && headingLine.test(m.text),
    )
  )
    throw new StoreError(
      "card_heading",
      "Instruction text cannot contain Markdown headings; Milton adds each report's heading. Nothing was changed.",
      422,
    );
  // Moving a rule to where it already is changes nothing.
  const moveTo = new Map(
    moves
      .filter((m) => known.get(m.id)!.report !== m.report)
      .map((m) => [m.id, m.report]),
  );
  const samplesChanged =
    (input.sample !== undefined && !sampleSkipped) ||
    input.retire_samples !== undefined;
  const unchanged =
    !samplesChanged &&
    moveTo.size === 0 &&
    creates.length === 0 &&
    retire.length === 0 &&
    updates.every((m) => known.get(m.id)?.body === m.text);
  if (unchanged) return result("unchanged", { version: current.version });
  const append = async (
    h: Pick<Head, "id" | "version" | "description" | "body" | "report">,
    archived: boolean,
    kind: string,
  ) => {
    await tx.query(sql`INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,archived,report,reason,actor_json,details_json)
        VALUES (${userId},${h.id},${h.version + 1},${h.description},${h.body},${archived},${h.report},'Filed memo',${attribution},${JSON.stringify({ kind, request_id: input.request_id })})`);
  };
  // Only explicit targets get new history rows. Omission preserves bytes,
  // descriptions, reports and versions; it never means retirement. A
  // rule both edited and moved gets one version carrying both.
  for (const memo of updates) {
    const old = known.get(memo.id)!;
    if (old.body === memo.text) continue;
    await append(
      {
        ...old,
        body: memo.text,
        report: moveTo.get(memo.id) ?? old.report,
      },
      false,
      "update",
    );
    moveTo.delete(memo.id);
  }
  for (const [id, report] of moveTo)
    await append({ ...known.get(id)!, report }, false, "move");
  for (const memo of creates) {
    const id = randomUUID();
    await tx.query(
      sql`INSERT INTO instruction_cards(user_id,id) VALUES (${userId},${id})`,
    );
    await append(
      {
        id,
        version: 0,
        description: describe(
          memo.text,
          Math.min(limits.description_bytes, 500),
        ),
        body: memo.text,
        report: memo.report,
      },
      false,
      "create",
    );
  }
  for (const id of retire) await append(known.get(id)!, true, "archive");
  await applySamples();
  return publishSave(ctx, tx, current, retired, attribution);
}
