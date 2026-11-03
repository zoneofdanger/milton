/** @jsxImportSource hono/jsx */
import { page } from "./pages";
import type { Child } from "hono/jsx";
import type { PersonStore } from "./store";
import type { TrialStatus } from "./store/trials";
import type { CompiledReport, Documents } from "./store/compiled";
import { ruleText } from "./store/reports";

export const isMemoRoute = (path: string) =>
  path === "/" ||
  path === "/download" ||
  path === "/memos" ||
  path.startsWith("/memos/") ||
  path === "/tps-report" ||
  path.startsWith("/tps-report/");

type PageStore = Pick<PersonStore, "readTpsReport"> &
  Partial<Pick<PersonStore, "trialStatus" | "readDocuments">> & {
    memoUpdates?(): Promise<
      | { limit: number; used: number; pending: number; resets_at: string }
      | undefined
    >;
  };

function trialBanner(status?: TrialStatus) {
  if (!status || status.status === "early_access" || status.status === "paid")
    return null;
  if (status.status === "trial" && !status.reminder_stage) return null;
  return (
    <aside class="small-note" aria-label="Milton subscription">
      <p>
        {status.status === "expired"
          ? "Your Milton trial has ended. Assistant reads and saves are paused. Your preferences are still here to view and download."
          : `Your Milton trial ends ${status.trial_ends_at!.slice(0, 10)} (UTC).`}{" "}
        {/* Plain text until billing exists: /billing has no route. */}
        Subscribe for $5.01/month.
      </p>
    </aside>
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
          <pre class="setup-copy">
            <code>{mcpUrl}</code>
          </pre>
        </li>
        <li>
          <h3>Start the conversation.</h3>
          <p>Once connected, copy this prompt into your assistant:</p>
          <blockquote class="setup-copy">
            {empty
              ? "Read my Milton cover sheet. It is empty, so run the setup questions it returns, one at a time. Show me the complete draft of rules and wait for my approval before saving anything."
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
const capitalised = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

type SheetView = {
  report: CompiledReport;
  documents?: (Documents & { version: string }) | null;
  email?: string;
  date: string;
  usage?: { used: number; limit: number; pending: number };
  comment: string;
};
/** The signed-in cover sheet as a T.P.S. report form. Page only: the download
 * and MCP serve the report text unchanged. */
function sheet({ report, documents, email, date, usage, comment }: SheetView) {
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
        <dl class="row">
          {field("Approved by", "Milton", true)}
          {usage &&
            field("Memo updates today", `${usage.used} of ${usage.limit}`)}
        </dl>
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
          {docs.cover_rules.length > 0 && (
            <section class="form-section">
              <h2>Always</h2>
              <p class="applies">Applies to everything you write.</p>
              {ruled(docs.cover_rules)}
            </section>
          )}
          {filed.map((r) => (
            <section class="form-section">
              <h2>{r.title}</h2>
              <p class="applies">Applies when {r.when}.</p>
              {r.samples.length > 0 && (
                <>
                  <p class="sub-label">Approved samples:</p>
                  {r.samples.map((s) => (
                    <details class="form-sample">
                      <summary>
                        <span class="box" aria-hidden="true">
                          ☑
                        </span>
                        <span class="typed">{capitalised(s.context)}</span>
                        <span class="date">{s.date}</span>
                      </summary>
                      {plain(s.body)}
                    </details>
                  ))}
                </>
              )}
              {r.rules.length > 0 && (
                <>
                  <p class="sub-label">Rules:</p>
                  {ruled(r.rules)}
                </>
              )}
            </section>
          ))}
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
) {
  return page(
    "Cover sheet",
    <>
      {notice}
      {!view.report.is_empty && !assistantPaused && (
        <p class="small-note sheet-meta">
          To change your cover sheet, tell a connected assistant what to change.
          {view.usage && " Memo updates reset at 00:00 UTC."}
          {view.usage && view.usage.pending > 0
            ? ` ${view.usage.pending} pending.`
            : ""}
        </p>
      )}
      {sheet(view)}
    </>,
    status,
    reportFonts,
    { account: { csrf, email: view.email, here: "report" }, sheet: true },
  );
}
export async function memoPages(
  request: Request,
  store: PageStore,
  csrf: () => Child,
  email?: string,
  /** Fixed values for tests; a request otherwise uses today (UTC) and a
   * random comment. */
  options: { now?: () => Date; comment?: () => string } = {},
): Promise<Response> {
  async function showCurrent(
    report: CompiledReport,
    notice: Child = null,
    status = 200,
    assistantPaused = false,
  ) {
    let documents: (Documents & { version: string }) | null = null;
    if (!report.is_empty && store.readDocuments) {
      try {
        documents = await store.readDocuments();
      } catch {
        // Optional presentation must never prevent canonical report access.
      }
    }
    let usage: SheetView["usage"];
    try {
      usage = await store.memoUpdates?.();
    } catch {
      // Advisory usage must not prevent viewing or downloading saved instructions.
    }
    return current(
      {
        report,
        documents,
        email,
        usage,
        date: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
        comment: (options.comment ?? randomComment)(),
      },
      csrf,
      notice,
      status,
      assistantPaused,
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
    trialBanner(trial),
    200,
    trial?.status === "expired",
  );
}
