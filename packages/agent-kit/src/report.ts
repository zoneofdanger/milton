export type Report = {
  /** Cover-sheet rules (or, for a report read, that report's text). */
  text: string;
  version: string;
  /** For the cover sheet: the whole account is empty, reports included. */
  is_empty: boolean;
  /** The cover sheet's index: one "when" line per report. */
  reports?: { id: string; when: string }[];
  /** First-setup questions, present only while the account is empty. */
  setup?: string;
};
export class MiltonReadError extends Error {
  readonly code: string;
  constructor(code = "milton_unavailable") {
    super("Current Milton instructions could not be confirmed.");
    this.code = code;
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseReport(raw: unknown): Report {
  if (object(raw) && raw.isError === true) {
    let code = "milton_unavailable";
    try {
      const p = JSON.parse(
        String((raw.content as { text: string }[])[0]!.text),
      );
      if (typeof p.error === "string" && /^[a-z_]{1,64}$/.test(p.error))
        code = p.error;
    } catch {}
    throw new MiltonReadError(code);
  }
  if (object(raw) && Array.isArray(raw.content)) {
    const first = raw.content.find(
      (c: unknown) =>
        object(c) && c.type === "text" && typeof c.text === "string",
    );
    // The wrapper is the JSON string of the whole envelope. The body is at most
    // 262144 bytes, JSON escaping at most doubles it (quotes, backslashes, and
    // line breaks become two bytes), and the other fields are small, so 1 MiB
    // holds every valid envelope while still bounding a runaway payload.
    if (
      !object(first) ||
      typeof first.text !== "string" ||
      Buffer.byteLength(first.text) > 1048576
    )
      throw new MiltonReadError("invalid_report");
    try {
      raw = JSON.parse(first.text) as unknown;
    } catch {
      throw new MiltonReadError("invalid_report");
    }
  }
  if (
    !object(raw) ||
    typeof raw.text !== "string" ||
    !raw.text.isWellFormed() ||
    raw.text.includes("\0") ||
    Buffer.byteLength(raw.text) > 262144 ||
    typeof raw.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.version) ||
    typeof raw.is_empty !== "boolean" ||
    // An empty cover sheet has no text; an empty report keeps its heading.
    (raw.is_empty && raw.report_id === undefined && raw.text !== "")
  )
    throw new MiltonReadError("invalid_report");
  const result: Report = {
    text: raw.text,
    version: raw.version,
    is_empty: raw.is_empty,
  };
  if (raw.reports !== undefined) {
    const index = raw.reports;
    if (
      !Array.isArray(index) ||
      index.length > 8 ||
      !index.every(
        (r: unknown) =>
          object(r) &&
          typeof r.id === "string" &&
          /^[a-z]{1,32}$/.test(r.id) &&
          typeof r.when === "string" &&
          r.when.length > 0 &&
          r.when.length <= 200,
      )
    )
      throw new MiltonReadError("invalid_report");
    result.reports = index.map((r: { id: string; when: string }) => ({
      id: r.id,
      when: r.when,
    }));
  }
  if (raw.setup !== undefined) {
    if (
      typeof raw.setup !== "string" ||
      !raw.setup.isWellFormed() ||
      raw.setup.includes("\0") ||
      Buffer.byteLength(raw.setup) > 32768
    )
      throw new MiltonReadError("invalid_report");
    result.setup = raw.setup;
  }
  return result;
}
