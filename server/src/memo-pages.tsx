/** @jsxImportSource hono/jsx */
import { billingItem, page, type BillingItem } from "./pages";
import type { Child } from "hono/jsx";
import type { PersonStore } from "./store";
import type { TrialStatus } from "./store/trials";
import type { CompiledReport, Documents } from "./store/compiled";
import { ruleText, type Sample } from "./store/reports";

export const isMemoRoute = (path: string) =>
  path === "/" || path === "/download" || path === "/tps-report";

type PageStore = Pick<PersonStore, "readTpsReport"> &
  Partial<Pick<PersonStore, "trialStatus" | "readDocuments">>;

// The note above the report, only when paying is pressing: a trial's last 7 days
// or a pause. The account menu always holds the action. Worded for everyone in the
// status: a paying person past grace reads the paused line, and someone with a card
// the trial line.
function billingNote(
  csrf: () => Child,
  billing: boolean,
  status?: TrialStatus,
) {
  const item = billing ? billingItem(status) : undefined;
  const banner = (message: string) => (
    <aside class="small-note billing-note" aria-label="Milton subscription">
      <p>{message}</p>
      {item && (
        <form method="post" action={`/billing/${item.action}`}>
          {csrf()}
          <button class="secondary">{item.label}</button>
        </form>
      )}
    </aside>
  );
  if (status?.status === "expired")
    return banner(
      "Assistant reads and saves are paused until you subscribe for $5.01/month. Your rules and samples are still here to view and download.",
    );
  const days = status?.days_left;
  if (status?.status !== "trial" || days === undefined || days > 7) return null;
  return banner(
    `${days} ${days === 1 ? "day" : "days"} left in your Milton trial, then it's $5.01/month. Unless you've already added a card, add one by then.`,
  );
}

const reportFonts = (
  <>
    <link
      rel="preload"
      href="/fonts/geist-latin-variable.woff2"
      as="font"
      type="font/woff2"
      crossorigin="anonymous"
    />
    <link
      rel="preload"
      href="/fonts/jetbrains-mono-regular.woff2"
      as="font"
      type="font/woff2"
      crossorigin="anonymous"
    />
  </>
);
// A child span prevents HTML's pre parser from swallowing a leading newline.
const plain = (text: string) => (
  <pre class="memo-text">
    <span>{text}</span>
  </pre>
);

/** The Comments line on the signed-in cover sheet: page decoration only. */
export const COVER_COMMENTS = [
  "Did you get the memo about the new cover sheets?",
  "Cover sheet attached. Please use it from now on.",
  "Red stapler located. Returned to owner.",
  "Please file in storage room B.",
  "Reviewed by both Bobs.",
  "Reminder: Hawaiian shirt day is Friday.",
  "Do not move desk without approval.",
  "Cake not received. Please advise.",
  "PC LOAD LETTER resolved.",
  "Copies sent to all eight bosses.",
  "Filed without a case of the Mondays.",
  "Minimum flair requirement met.",
] as const;
const randomComment = () =>
  COVER_COMMENTS[Math.floor(Math.random() * COVER_COMMENTS.length)]!;

/** The two setup steps, shown on Connected assistants; `mcpUrl` is this
 * deployment's MCP resource. */
export function connectSteps(empty: boolean, mcpUrl: string) {
  return (
    <section class="connect-steps" id="connect" aria-labelledby="connect-h">
      <h2 id="connect-h">Connect an assistant</h2>
      <ol class="setup-steps">
        <li>
          <h3>Add Milton in your assistant’s settings.</h3>
          <p>
            Use this address in its MCP or connector settings, then complete
            sign-in and approve the connection. Availability depends on your
            assistant and plan.
          </p>
          <p>
            <a href="https://www.meetmilton.com/setup">
              Setup instructions for your assistant
            </a>
            . Follow the guide to connect Milton and set the instruction for
            future chats.
          </p>
          <pre class="setup-copy">
            <code>{mcpUrl}</code>
          </pre>
        </li>
        <li>
          <h3>Start the conversation.</h3>
          <p>Once connected, copy this prompt into your assistant:</p>
          <blockquote class="setup-copy">
            {empty
              ? "Read my Milton cover sheet. It is empty, so run the setup it returns exactly as written, one question at a time, starting with an email I paste. Show me the complete list of rules and wait for my approval before saving any rules."
              : "Read my Milton cover sheet, then the report that fits what we’re writing, and write like me."}
          </blockquote>
        </li>
      </ol>
      {empty && (
        <p>
          Your account starts empty. Approve the complete draft before saving
          instructions, or leave it empty.
        </p>
      )}
    </section>
  );
}

const field = (label: string, value: Child, grow = false) => (
  <div class={grow ? "field grow" : "field"}>
    <dt>{label}:</dt>
    <dd class="fill">{value}</dd>
  </div>
);
// The list supplies the number; ruleText drops a stored "- " as assembly does.
const ruled = (bodies: string[]) => (
  <ol class="ruled">
    {bodies.map((body) => (
      <li class="line">
        <span class="typed">{ruleText(body)}</span>
      </li>
    ))}
  </ol>
);
const counted = (n: number, label: string) =>
  `${n} ${label}${n === 1 ? "" : "s"}`;
/** A sample's labels as one line, or "" when it has none. */
const labelLine = (s: Sample) =>
  [s.audience, s.purpose, s.register].filter(Boolean).join(", ");

type SheetView = {
  report: CompiledReport;
  documents?: (Documents & { version: string }) | null;
  email?: string;
  date: string;
  comment: string;
};
/** The signed-in cover sheet as a T.P.S. report form. Page only: the download
 * and MCP serve the report text unchanged. */
function sheet({ report, documents, email, date, comment }: SheetView) {
  const docs = documents?.version === report.version ? documents : null;
  const filed = docs?.reports.filter((r) => !r.is_empty) ?? [];
  const counts = report.is_empty
    ? { reports: "None", rules: 0, samples: 0 }
    : docs && {
        reports: filed.map((r) => r.title).join(", ") || "None",
        rules:
          docs.cover_rules.length +
          filed.reduce((n, r) => n + r.rules.length, 0),
        samples: filed.reduce((n, r) => n + r.samples.length, 0),
      };
  return (
    <article class="sheet tps-form" aria-label="Cover sheet">
      <header class="form-title">
        {/* One heading, read as "T.P.S. Report, cover sheet". */}
        <h1 aria-label="T.P.S. Report, cover sheet">
          T.P.S. Report
          <span class="form-subtitle">Cover sheet</span>
        </h1>
      </header>
      <div class="form-fields">
        <dl class="row">
          {field("Prepared for", email ?? "", true)}
          {field("Date", `${date} UTC`)}
        </dl>
        {counts && (
          <dl class="row">
            {field("Reports", counts.reports, true)}
            {field("Rules", counts.rules)}
            {field("Samples", counts.samples)}
          </dl>
        )}
        <dl class="row">{field("Filed by", "Milton", true)}</dl>
      </div>
      {report.is_empty ? (
        <div class="form-empty">
          <p class="empty-placeholder">No instructions on file.</p>
          <p>
            <a href="/assistants#connect">Follow the setup steps</a> to connect
            an assistant and start your cover sheet.
          </p>
        </div>
      ) : docs ? (
        <>
          {(docs.cover_rules.length > 0 || filed.length > 0) && (
            <nav class="report-index" aria-label="On this report">
              <p>On this report</p>
              <ul>
                {docs.cover_rules.length > 0 && (
                  <li>
                    <a href="#report-always">
                      <span>Always</span>
                      <span class="report-counts">
                        {counted(docs.cover_rules.length, "rule")}
                      </span>
                    </a>
                  </li>
                )}
                {filed.map((r) => (
                  <li>
                    <a href={`#report-${r.id}`}>
                      <span>{r.title}</span>
                      <span class="report-counts">
                        {`${counted(r.samples.length, "sample")} · ${counted(r.rules.length, "rule")}`}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {docs.cover_rules.length > 0 && (
            <section class="form-section">
              <h2 id="report-always">Always</h2>
              <p class="report-counts">
                {counted(docs.cover_rules.length, "rule")}
              </p>
              <p class="applies">Applies to everything you write.</p>
              {ruled(docs.cover_rules)}
            </section>
          )}
          {filed.map((r) => (
            <section class="form-section">
              <h2 id={`report-${r.id}`}>{r.title}</h2>
              <p class="report-counts">
                {`${counted(r.samples.length, "sample")} · ${counted(r.rules.length, "rule")}`}
              </p>
              <p class="applies">Applies when {r.when}.</p>
              {r.samples.length > 0 && (
                <>
                  <h3 class="sub-label">
                    Approved samples ({r.samples.length})
                  </h3>
                  {r.samples.map((s) => (
                    <details class="form-sample">
                      <summary>
                        <span class="typed">{s.context}</span>
                        <span class="sample-meta">
                          {labelLine(s) && (
                            <span class="labels">{labelLine(s)}</span>
                          )}
                          <span class="date">{s.date}</span>
                        </span>
                      </summary>
                      {plain(s.body)}
                    </details>
                  ))}
                </>
              )}
              {r.rules.length > 0 && (
                <>
                  <h3 class="sub-label">Rules ({r.rules.length})</h3>
                  {ruled(r.rules)}
                </>
              )}
            </section>
          ))}
          {/* Later setup blocks run on request only, so say how to ask. */}
          {docs.reports.some((r) => r.rules.length === 0) && (
            <section class="form-section">
              <h2>Not set up yet</h2>
              {docs.reports
                .filter((r) => r.rules.length === 0)
                .map((r) => (
                  <p class="applies">
                    {`Tell any connected assistant: set up my ${r.id} report.`}
                  </p>
                ))}
            </section>
          )}
        </>
      ) : (
        <div class="form-section">{plain(report.text)}</div>
      )}
      <section class="form-section">
        <h2>Comments</h2>
        <p class="line typed comment">{comment}</p>
        <div class="line" aria-hidden="true"></div>
        <div class="line" aria-hidden="true"></div>
      </section>
      <footer class="confidential">Confidential</footer>
    </article>
  );
}

function current(
  view: SheetView,
  csrf: () => Child,
  notice: Child = null,
  status = 200,
  assistantPaused = false,
  billing?: BillingItem,
) {
  return page(
    "Cover sheet",
    <>
      {notice}
      {!view.report.is_empty && !assistantPaused && (
        <p class="small-note sheet-meta">
          To change your cover sheet, tell a connected assistant what to change.
        </p>
      )}
      {sheet(view)}
    </>,
    status,
    reportFonts,
    {
      account: { csrf, email: view.email, here: "report", billing },
      sheet: true,
    },
  );
}
export async function memoPages(
  request: Request,
  store: PageStore,
  csrf: () => Child,
  email?: string,
  /** billing says Stripe is configured. Fixed values for tests; a request
   * otherwise uses today (UTC) and a random comment. */
  options: { billing?: boolean; now?: () => Date; comment?: () => string } = {},
): Promise<Response> {
  async function showCurrent(
    report: CompiledReport,
    notice: Child = null,
    status = 200,
    assistantPaused = false,
    billing?: BillingItem,
  ) {
    let documents: (Documents & { version: string }) | null = null;
    if (!report.is_empty && store.readDocuments) {
      try {
        documents = await store.readDocuments();
      } catch {
        // Optional presentation must never prevent canonical report access.
      }
    }
    return current(
      {
        report,
        documents,
        email,
        date: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
        comment: (options.comment ?? randomComment)(),
      },
      csrf,
      notice,
      status,
      assistantPaused,
      billing,
    );
  }
  const path = new URL(request.url).pathname;
  if (!["/", "/tps-report", "/download"].includes(path))
    return page("Not found", <p>This page does not exist.</p>, 404);
  if (request.method !== "GET" && request.method !== "POST")
    return page("Method not allowed", "", 405);
  if (request.method !== "GET")
    return page("Not found", <p>This page does not exist.</p>, 404);
  const report = await store.readTpsReport();
  if (path === "/download")
    return new Response(report.text, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="TPS.md"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  // Billing information is page chrome, never part of the report/download.
  const trial = await store.trialStatus?.().catch(() => undefined);
  return showCurrent(
    report,
    billingNote(csrf, options.billing ?? false, trial),
    200,
    trial?.status === "expired",
    options.billing ? billingItem(trial) : undefined,
  );
}
