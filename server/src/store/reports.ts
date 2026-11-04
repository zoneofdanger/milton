import type { CardHead } from "./cards";

/** The five fixed reports. IDs are singular words naming the kind of writing,
 * so an assistant can guess them without the cover sheet. A sixth is a code
 * change plus a cover-sheet line. */
export const REPORT_IDS = [
  "email",
  "chat",
  "post",
  "document",
  "speech",
] as const;
export type ReportId = (typeof REPORT_IDS)[number];
/** Where a rule is filed: one of the reports, or the cover sheet. */
export const FILINGS = [...REPORT_IDS, "cover"] as const;
export type Filing = (typeof FILINGS)[number];
export const REPORTS: { id: ReportId; title: string; when: string }[] = [
  {
    id: "email",
    title: "Email",
    when: "drafting an email I'll send, warm or cold",
  },
  {
    id: "chat",
    title: "Chat",
    when: "drafting a message in a thread or DM: Slack, Teams, text, or a LinkedIn message",
  },
  {
    id: "post",
    title: "Post",
    when: "writing something published under my name: a LinkedIn post, an X post, a blog post",
  },
  {
    id: "document",
    title: "Document",
    when: "writing a doc, memo, summary, or update for others to read",
  },
  {
    id: "speech",
    title: "Speech",
    when: "writing words I'll say aloud: a toast, a talk intro, a voicemail",
  },
];
/** `doc` is accepted for `document`; everything else must match exactly. */
export const resolveReportId = (id: string): ReportId | undefined =>
  id === "doc" ? "document" : REPORT_IDS.find((known) => known === id);

/** Labels an assistant may give a sample when saving it, and audience and
 * purpose when reading a report. Stored as sent and compared for equality only. */
export const AUDIENCES = [
  "client",
  "boss",
  "colleague",
  "friend",
  "public",
  "other",
] as const;
export const PURPOSES = [
  "decline",
  "ask",
  "thank",
  "update",
  "announce",
  "apologize",
  "introduce",
  "follow up",
  "other",
] as const;
export const REGISTERS = ["formal", "plain", "casual"] as const;

/** What a report read is for: the report, one line on the situation, and the
 * audience and purpose when the assistant knows them. */
export type ReportIntent = {
  report: ReportId;
  situation: string;
  audience?: (typeof AUDIENCES)[number];
  purpose?: (typeof PURPOSES)[number];
};

export type Sample = {
  id: string;
  report: ReportId;
  kind_id: string;
  /** The kind's label; never printed in report text. */
  kind: string;
  context: string;
  body: string;
  /** YYYY-MM-DD, UTC, shown above the sample. */
  date: string;
  /** Full UTC timestamp, for ordering only. */
  created_at: string;
  /** Labels the saving assistant chose; null when it sent none (0033). */
  audience: (typeof AUDIENCES)[number] | null;
  purpose: (typeof PURPOSES)[number] | null;
  register: (typeof REGISTERS)[number] | null;
};
export type ReportDocument = {
  id: ReportId;
  title: string;
  when: string;
  body: string;
  is_empty: boolean;
  /** The same content as body, structured for the web page. */
  samples: Sample[];
  rules: string[];
};
export type Documents = {
  /** Universal rules as text. Never carries samples; the index travels beside it. */
  cover: string;
  cover_rules: string[];
  /** One "when" line per report, in fixed order. */
  index: { id: ReportId; when: string }[];
  reports: ReportDocument[];
  /** Cover sheet and every non-empty report, for the web page and TPS.md. */
  full: string;
  /** No rules anywhere and no samples: first setup applies. */
  is_empty: boolean;
};

const rules = (active: CardHead[], report: Filing) =>
  active.filter((h) => h.report === report).map((h) => h.body);
/** A rule's text without its bullet: one stored leading "- " (the retired
 * compiler's) dropped. The stored bytes stay as they are. */
export const ruleText = (body: string) =>
  body.startsWith("- ") ? body.slice(2) : body;
/** One rule as printed: a bullet, whether the body was stored with the retired
 * compiler's leading "- " or as sent since. */
export const bullet = (body: string) => "- " + ruleText(body);
const quote = (body: string) =>
  body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** The prefix setup gives every rule it files. */
export const BASELINE = "Baseline: ";
/** Printed first on the cover sheet whenever any active rule is a baseline,
 * so every assistant reads what the prefix means. Never stored. */
export const BASELINE_NOTE =
  "Rules marked Baseline: came from setup picks, not the person's writing; samples and unmarked rules outrank them.";
const coverSheetText = (active: CardHead[]) =>
  [
    ...(active.some((h) => ruleText(h.body).startsWith(BASELINE))
      ? [BASELINE_NOTE]
      : []),
    ...rules(active, "cover").map(bullet),
  ].join("\n\n");
const reportIndex = () => REPORTS.map((r) => ({ id: r.id, when: r.when }));
/** Samples a report serves; every active sample stays stored. */
export const SERVED_SAMPLES = 8;
/** Heading, the when line, the served samples (context line, quoted body),
 * then rules as bullets. The served samples are `ranked`, in that order, when a
 * read ranked them for an intent; otherwise the newest eight, newest first.
 * Every stored byte of a rule or sample is preserved, apart from one leading
 * "- " a bullet replaces. */
function reportDocument(
  report: (typeof REPORTS)[number],
  active: CardHead[],
  samples: Sample[],
  ranked?: string[],
): ReportDocument {
  const mine = samples.filter((s) => s.report === report.id);
  const own = ranked
    ? ranked.flatMap((id) => mine.filter((s) => s.id === id))
    : mine
        .sort((a, b) =>
          a.created_at === b.created_at
            ? b.id.localeCompare(a.id)
            : a.created_at < b.created_at
              ? 1
              : -1,
        )
        .slice(0, SERVED_SAMPLES);
  const parts = [
    `# ${report.title}`,
    `Applies when ${report.when}.`,
    ...own.map((s) => `Approved, ${s.context}, ${s.date}:\n${quote(s.body)}`),
    ...rules(active, report.id).map(bullet),
  ];
  return {
    id: report.id,
    title: report.title,
    when: report.when,
    body: parts.join("\n\n"),
    is_empty: parts.length === 2,
    samples: own,
    rules: rules(active, report.id),
  };
}
/** The cover sheet and the five reports. `ranked` replaces one report's newest
 * eight with the samples a read ranked for its intent. */
export function assembleDocuments(
  active: CardHead[],
  samples: Sample[],
  ranked?: { report: ReportId; ids: string[] },
): Documents {
  const cover = coverSheetText(active);
  const reports = REPORTS.map((r) =>
    reportDocument(
      r,
      active,
      samples,
      r.id === ranked?.report ? ranked.ids : undefined,
    ),
  );
  return {
    cover,
    cover_rules: rules(active, "cover"),
    index: reportIndex(),
    reports,
    full: [cover, ...reports.filter((r) => !r.is_empty).map((r) => r.body)]
      .filter(Boolean)
      .join("\n\n"),
    is_empty: active.length === 0 && samples.length === 0,
  };
}
