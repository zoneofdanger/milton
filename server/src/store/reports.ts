import {
  contextDetails,
  contextMatch,
  type SampleContext,
  type ContextDimensions,
} from "./sample-context";
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

/** Intent is required; supplied dimensions use the saved context vocabulary. */
export type ReportIntent = {
  report: ReportId;
  situation: string;
  kind_id?: string;
  context?: ContextDimensions;
};
export type Sample = {
  id: string;
  report: ReportId;
  kind_id: string;
  kind: string;
  context: SampleContext;
  revision: number;
  body: string;
  date: string;
  created_at: string;
  revised_at: string;
  lexical_rank?: number;
  match?: { kind?: boolean; purposes: string[]; dimensions: string[] };
};
export type ReportDocument = {
  id: ReportId;
  title: string;
  when: string;
  body: string;
  is_empty: boolean;
  /** The same content as body, structured for the web page. */
  samples: Sample[];
  /** Every kind with an active sample in this report, before selection. */
  kinds: { kind_id: string; kind: string }[];
  rules: string[];
};
export type Documents = {
  /** Universal rules as text. Never carries samples; the index travels beside it. */
  cover: string;
  cover_rules: string[];
  /** One "when" line per report, in fixed order. */
  index: { id: ReportId; when: string }[];
  reports: ReportDocument[];
  /** Cover sheet and every non-empty report, with the selected samples. */
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
const newestFirst = (samples: Sample[]) =>
  samples.toSorted((a, b) =>
    a.revised_at === b.revised_at
      ? b.id.localeCompare(a.id)
      : a.revised_at < b.revised_at
        ? 1
        : -1,
  );
/** Heading, the when line, the selected samples (context line, quoted body),
 * then rules as bullets. The caller selects and orders the samples.
 * Every stored byte of a rule or sample is preserved, apart from one leading
 * "- " a bullet replaces. */
function reportDocument(
  report: (typeof REPORTS)[number],
  active: CardHead[],
  own: Sample[],
  all: Sample[] = own,
): ReportDocument {
  const parts = [
    `# ${report.title}`,
    `Applies when ${report.when}.`,
    ...own.map(
      (s) =>
        `Approved, ${s.context.summary}, ${s.date}:${contextDetails(s.context) ? `\nContext: ${contextDetails(s.context)}` : ""}\n${quote(s.body)}`,
    ),
    ...rules(active, report.id).map(bullet),
  ];
  return {
    id: report.id,
    title: report.title,
    when: report.when,
    body: parts.join("\n\n"),
    is_empty: parts.length === 2,
    samples: own,
    kinds: Array.from(
      new Map(all.map((s) => [s.kind_id, s.kind])),
      ([kind_id, kind]) => ({ kind_id, kind }),
    ).sort((a, b) => a.kind_id.localeCompare(b.kind_id)),
    rules: rules(active, report.id),
  };
}
const fullText = (cover: string, reports: ReportDocument[]) =>
  [cover, ...reports.filter((r) => !r.is_empty).map((r) => r.body)]
    .filter(Boolean)
    .join("\n\n");

/** The download includes every active sample, newest first within each report. */
export function assembleExport(active: CardHead[], samples: Sample[]): string {
  return fullText(
    coverSheetText(active),
    REPORTS.map((r) =>
      reportDocument(
        r,
        active,
        newestFirst(samples.filter((s) => s.report === r.id)),
      ),
    ),
  );
}
/** Unweighted, explicit tiers; broad examples fill all remaining slots. */
function rankSamples(samples: Sample[], intent: ReportIntent) {
  return samples
    .map((s) => ({
      ...s,
      match: {
        ...(intent.kind_id ? { kind: s.kind_id === intent.kind_id } : {}),
        ...contextMatch(s.context, intent.context),
      },
    }))
    .sort(
      (a, b) =>
        Number(b.match.kind ?? false) - Number(a.match.kind ?? false) ||
        b.match.purposes.length - a.match.purposes.length ||
        b.match.dimensions.length - a.match.dimensions.length ||
        (b.lexical_rank ?? 0) - (a.lexical_rank ?? 0) ||
        (a.revised_at < b.revised_at
          ? 1
          : a.revised_at > b.revised_at
            ? -1
            : a.id.localeCompare(b.id)),
    )
    .slice(0, SERVED_SAMPLES);
}
/** The cover sheet and the five reports. `ranked` replaces one report's newest
 * eight with the samples a read ranked for its intent. */
export function assembleDocuments(
  active: CardHead[],
  samples: Sample[],
  ranked?: { report: ReportId; intent: ReportIntent },
): Documents {
  const cover = coverSheetText(active);
  const reports = REPORTS.map((r) => {
    const mine = samples.filter((s) => s.report === r.id);
    return reportDocument(
      r,
      active,
      r.id === ranked?.report
        ? rankSamples(mine, ranked.intent)
        : newestFirst(mine).slice(0, SERVED_SAMPLES),
      mine,
    );
  });
  return {
    cover,
    cover_rules: rules(active, "cover"),
    index: reportIndex(),
    reports,
    full: fullText(cover, reports),
    is_empty: active.length === 0 && samples.length === 0,
  };
}
