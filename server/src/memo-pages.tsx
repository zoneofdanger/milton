/** @jsxImportSource hono/jsx */
import { page } from "./pages";
import type { Child } from "hono/jsx";
import type { PersonStore } from "./store";
import type { TrialStatus } from "./store/trials";
import type { CompiledReport, Documents } from "./store/compiled";

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
        <a href="/billing">Subscribe for $5.01/month</a>
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
function sheet(content: Child) {
  return (
    <article class="sheet tps-sheet" aria-label="Cover sheet">
      <div class="sheet-bar">Milton</div>
      <header class="tps-title">
        <h1>Cover sheet</h1>
        <p class="cover-subtitle">How you write</p>
      </header>
      {content}
      <div class="document-end" aria-hidden="true"></div>
    </article>
  );
}
function connectionHelp(empty: boolean) {
  return (
    <details class="connection-help" open={empty}>
      <summary>Connect an assistant</summary>
      <ol class="setup-steps">
        <li>
          <h3>Add Milton in your assistant’s settings.</h3>
          <p>
            Use this address in its MCP or connector settings, then complete
            sign-in and approve the connection. Availability depends on your
            assistant and plan.
          </p>
          <pre class="setup-copy">
            <code>https://mcp.meetmilton.com/mcp</code>
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
    </details>
  );
}
/**
 * Authenticated page chrome: navigation, the signed-in account (never shown on
 * public pages or in downloads), and sign-out. "Switch account" signs out to
 * the sign-in page; signing out never disconnects assistants.
 */
export function accountChrome(
  csrf: () => Child,
  email: string | undefined,
  here: "report" | "assistants" | "delete",
) {
  return (
    <>
      <nav aria-label={here === "report" ? "Report" : "Account"}>
        {here === "report" ? (
          <>
            <a href="/download">Download TPS.md</a>
            <a href="/assistants">Connected assistants</a>
          </>
        ) : (
          <a href="/">Cover sheet</a>
        )}
        <form class="signout" method="post" action="/logout">
          {csrf()}
          <button
            class="secondary"
            name="next"
            value="login"
            aria-describedby="signout-note"
          >
            Switch account
          </button>
          <button class="secondary" aria-describedby="signout-note">
            Sign out
          </button>
        </form>
      </nav>
      <p class="small-note" id="signout-note">
        {email && <>Signed in as {email}. </>}
        Signing out of this browser does not disconnect your assistants.
        {here === "report" && (
          <>
            {" "}
            To disconnect one, use{" "}
            <a href="/assistants">Connected assistants</a>.
          </>
        )}
      </p>
      {here !== "delete" && (
        <p class="small-note">
          <a href="/account/delete">Delete account</a>
        </p>
      )}
    </>
  );
}

function current(
  report: CompiledReport,
  csrf: () => Child,
  notice: Child = null,
  status = 200,
  documents?: (Documents & { version: string }) | null,
  assistantPaused = false,
  email?: string,
) {
  const docs = documents?.version === report.version ? documents : null;
  // The list supplies the bullet; a one-line "- " card shows without its marker.
  const item = (body: string) =>
    body.startsWith("- ") && !body.includes("\n") ? body.slice(2) : body;
  const rules = (bodies: string[]) =>
    bodies.length > 0 && (
      <ul class="instruction-list">
        {bodies.map((body) => (
          <li>{item(body)}</li>
        ))}
      </ul>
    );
  return page(
    "Cover sheet",
    <>
      {accountChrome(csrf, email, "report")}
      {notice}
      {connectionHelp(report.is_empty)}
      {!report.is_empty && !assistantPaused && (
        <p class="small-note">
          To change these instructions, ask a connected assistant to save the
          update with Milton.
        </p>
      )}
      {sheet(
        <div class="document-body">
          {report.is_empty ? (
            <p class="empty-placeholder">No instructions on file.</p>
          ) : docs ? (
            <>
              {rules(docs.cover_rules)}
              {docs.reports
                .filter((r) => !r.is_empty)
                .map((r) => (
                  <>
                    <h2 class="instruction-group">{r.title}</h2>
                    <p class="small-note">Applies when {r.when}.</p>
                    {r.samples.map((s) => (
                      <figure class="sample">
                        <figcaption>
                          Approved, {s.context}, {s.date}
                        </figcaption>
                        <blockquote>{plain(s.body)}</blockquote>
                      </figure>
                    ))}
                    {rules(r.rules)}
                  </>
                ))}
            </>
          ) : (
            plain(report.text)
          )}
        </div>,
      )}
    </>,
    status,
    reportFonts,
    "tps",
  );
}
export async function memoPages(
  request: Request,
  store: PageStore,
  csrf: () => Child,
  email?: string,
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
    let usage: Child = null;
    try {
      const balance = await store.memoUpdates?.();
      if (balance) {
        usage = (
          <p class="small-note" aria-label="Memo updates">
            {balance.used} of {balance.limit} memo updates used today.
            {balance.pending > 0 ? ` ${balance.pending} pending.` : ""} Resets
            at 00:00 UTC.
          </p>
        );
      }
    } catch {
      // Advisory usage must not prevent viewing or downloading saved instructions.
    }
    return current(
      report,
      csrf,
      <>
        {notice}
        {usage}
      </>,
      status,
      documents,
      assistantPaused,
      email,
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
