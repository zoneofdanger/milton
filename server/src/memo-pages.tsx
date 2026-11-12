/** @jsxImportSource hono/jsx */
import { billingItem, page, type BillingItem } from "./pages";
import type { Child } from "hono/jsx";
import type { PersonStore } from "./store";
import type { TrialStatus } from "./store/trials";
import type { FullMemo, TpsChange, TpsMemo, TpsView } from "./store/tps";
import { LISTED_MEMOS } from "./store/tps";
import { SCOREBOARD_MIN, type Scoreboard, type ScoreLine } from "./store/score";
import { SETUP_PROMPT } from "@milton/theme/setup-prompt";
import { clientHost } from "./auth-assistants";

// The TPS page's routes. "/" also serves the signed-out landing page, so the
// browser router sends it here only for a signed-in person.
const GETS = ["/", "/download", "/tps-report"];
const POSTS = [
  "/tps/forget",
  "/tps/request/remove",
  "/tps/tweaks/delete",
  "/tps/tweaks/reword",
];
const MEMO_PATH = /^\/tps\/memo\/([^/]+)$/;
const ID = /^[0-9a-f-]{36}$/;
/** The one method a TPS route answers, or undefined for any other path. */
export const memoMethod = (path: string) =>
  GETS.includes(path) || MEMO_PATH.test(path)
    ? "GET"
    : POSTS.includes(path)
      ? "POST"
      : undefined;
export const isMemoRoute = (path: string) => memoMethod(path) !== undefined;

type PageStore = Pick<
  PersonStore,
  | "read"
  | "readMemo"
  | "exportTps"
  | "forgetMemo"
  | "removeRequest"
  | "deleteTweak"
  | "rewordTweak"
> &
  Partial<Pick<PersonStore, "trialStatus">>;

export type MemoPageContext = {
  csrf: () => Child;
  /** The CSRF- and Origin-checked form of a POST. */
  readForm: () => Promise<URLSearchParams>;
  appOrigin: string;
  email?: string;
  /** Stripe is configured. */
  billing?: boolean;
  /** Fixed values for tests; a request otherwise uses today (UTC) and a
   * random comment. */
  now?: () => Date;
  comment?: () => string;
};

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
      "AI reads and saves are paused until you subscribe for $5.01/month. Your memos, tweaks and cover sheet are still here to view and download.",
    );
  const days = status?.days_left;
  if (status?.status !== "trial" || days === undefined || days > 7) return null;
  return banner(
    `${days} ${days === 1 ? "day" : "days"} left in your Milton trial, then it's $5.01/month. Unless you've already added a card, add one by then.`,
  );
}

// A child span prevents HTML's pre parser from swallowing a leading newline.
const plain = (text: string) => (
  <pre class="memo-text">
    <span>{text}</span>
  </pre>
);

/** The Comments line on the signed-in TPS report: page decoration only. */
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

/** The two setup steps, shown on Connected AIs; `mcpUrl` is this
 * deployment's MCP resource. */
export function connectSteps(empty: boolean, mcpUrl: string) {
  return (
    <section class="connect-steps" id="connect" aria-labelledby="connect-h">
      <h2 id="connect-h">Connect an AI</h2>
      <ol class="setup-steps">
        <li>
          <h3>Add Milton in your AI’s settings.</h3>
          <p>
            Use this address in its MCP or connector settings, then complete
            sign-in and approve the connection. Availability depends on your AI
            and plan.
          </p>
          <p>
            <a href="https://www.meetmilton.com/setup">
              Setup instructions for your AI
            </a>
            . Follow the guide to connect Milton and add the standing
            instruction.
          </p>
          <pre class="setup-copy">
            <code>{mcpUrl}</code>
          </pre>
        </li>
        <li>
          <h3>Start the conversation.</h3>
          <p>Once connected, copy this prompt into your AI:</p>
          <blockquote class="setup-copy">
            <p>
              {empty
                ? SETUP_PROMPT
                : "Read my Milton cover sheet and the report for my next email or DM, and draft it from what’s on file. Ask what the message should accomplish."}
            </p>
          </blockquote>
        </li>
      </ol>
      {empty && (
        <p>
          Your account starts empty; start with about five things you wrote and
          sent, found in your email by your AI or pasted.
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
const counted = (n: number, label: string) =>
  `${n.toLocaleString("en-US")} ${label}${n === 1 ? "" : "s"}`;
const day = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const when = (at: string) => (
  <time datetime={at}>{day.format(new Date(at))}</time>
);
const MEDIUM = {
  email: "Email",
  chat: "Chat",
  post: "Post",
  document: "Document",
  speech: "Speech",
} as const;
const TIER = {
  own: "your words",
  steered: "steered by you",
  untouched: "accepted untouched",
} as const;
/** "Email · vendor decline": the row's medium and kind. */
const memoLabel = (m: TpsMemo) =>
  [MEDIUM[m.medium], m.kind].filter(Boolean).join(" · ");
/** Which AI saved it: the host of a connected AI's client, a connection key,
 * or a neutral label when neither is known. */
const clientLabel = (client: TpsMemo["client"]) =>
  client.issuer === "connection_key"
    ? "Connection key"
    : clientHost(client.client_id) || "Connected AI";
/** "2 rounds" for a memo with a first draft; "your words" otherwise. */
const roundsLabel = (m: TpsMemo) =>
  m.rounds === undefined ? undefined : counted(m.rounds, "round");
/** "You asked:" with the request's first line, on a listed memo. */
const askedLine = (m: TpsMemo) =>
  m.asked !== undefined && (
    <p class="memo-tweaks">
      <span class="tweak-label">You asked:</span>{" "}
      <span class="typed">{m.asked}</span>
    </p>
  );
const tweakList = (label: string, tweaks: { text: string }[]) =>
  tweaks.length > 0 && (
    <p class="memo-tweaks">
      <span class="tweak-label">{label}:</span>{" "}
      <span class="typed">{tweaks.map((t) => t.text).join(" · ")}</span>
    </p>
  );

const forgetForm = (csrf: () => Child, m: TpsMemo) => (
  <form method="post" action="/tps/forget">
    {csrf()}
    <input type="hidden" name="memo" value={m.id} />
    <button
      class="secondary compact"
      aria-label={`Forget memo: ${memoLabel(m)}, ${day.format(new Date(m.at))}`}
    >
      Forget
    </button>
  </form>
);

// Scoreboard numbers as the spec writes them: "1 round, 18% changed, 40%
// accepted as-is". A median may fall between two counts.
const rounds = (n: number) =>
  `${Number.isInteger(n) ? n : n.toFixed(1)} round${n === 1 ? "" : "s"}`;
const percent = (n: number) => `${Math.round(n * 100)}%`;
const scoreLine = (line: ScoreLine) =>
  `${rounds(line.rounds)}, ${percent(line.change)} changed, ${percent(line.accepted)} accepted as-is`;
const scoreShort = (line: ScoreLine) =>
  `${rounds(line.rounds)}, ${percent(line.change)}, ${percent(line.accepted)}`;
function scoreboardLine(score: Scoreboard) {
  const label = score.mode === "draft" ? "First drafts" : "Edits";
  if (!score.latest && !score.earlier && score.basis === undefined) {
    const more = SCOREBOARD_MIN - score.count;
    return `${label}: ${score.count === 0 ? "no scored memos yet" : `${counted(score.count, "scored memo")} so far`}. ${more} more to start the scoreboard.`;
  }
  if (score.basis === "days")
    return `${label}, last 30 days: ${score.latest ? scoreLine(score.latest) : "no scored memos"} (the 30 days before: ${score.earlier ? scoreShort(score.earlier) : "none"})`;
  return `${label}: ${scoreLine(score.latest!)} (your first five: ${scoreShort(score.earlier!)})`;
}

/** The line a change's redirect shows, in the section it changed. */
const NOTICES = {
  forgot: ["memos", "Memo forgotten."],
  "tweak-deleted": ["tweaks", "Tweak deleted."],
  "tweak-reworded": ["tweaks", "Tweak reworded."],
} as const;
type Done = keyof typeof NOTICES;
type Notices = Partial<Record<"memos" | "tweaks", Child>>;

type SheetView = {
  view: TpsView;
  email?: string;
  date: string;
  comment: string;
  csrf: () => Child;
  notices: Notices;
};
/** The signed-in TPS report as a printed form: the cover sheet, read only,
 * the scoreboard, the memos newest first and the person's tweaks. */
function sheet({ view, email, date, comment, csrf, notices }: SheetView) {
  const empty = !view.cover_sheet.text && view.memos.length === 0;
  const listed =
    view.memos.length >= LISTED_MEMOS
      ? `${LISTED_MEMOS}+`
      : String(view.memos.length);
  return (
    <article class="sheet tps-form" aria-label="TPS report">
      <header class="form-title">
        {/* One heading, read as "T.P.S. Report, memos and tweaks". */}
        <h1 aria-label="T.P.S. Report, memos and tweaks">
          T.P.S. Report
          <span class="form-subtitle">Memos and tweaks</span>
        </h1>
      </header>
      <div class="form-fields">
        <dl class="row">
          {field("Prepared for", email ?? "", true)}
          {field("Date", `${date} UTC`)}
        </dl>
        <dl class="row">
          {field("Memos", listed)}
          {field("Tweaks", String(view.tweaks.length))}
          {field("Keep memos", view.keep_memos ? "On" : "Off", true)}
        </dl>
        <dl class="row">{field("Filed by", "Milton", true)}</dl>
      </div>
      {empty ? (
        <div class="form-empty">
          <p class="empty-placeholder">No memos on file yet.</p>
          <p>
            <a href="/assistants#connect">Follow the setup steps</a> to connect
            an AI, then give it about five things you wrote and sent: it can
            find them in your email if it already has access, or you paste them.
            Your AI keeps each one you approve as a memo here.
          </p>
          <p>Once connected, copy this prompt into your AI:</p>
          <blockquote class="setup-copy">
            <p>{SETUP_PROMPT}</p>
          </blockquote>
        </div>
      ) : (
        <nav class="report-index" aria-label="On this report">
          <p>On this report</p>
          <ul>
            <li>
              <a href="#cover-sheet">Cover sheet</a>
            </li>
            <li>
              <a href="#scoreboard">Scoreboard</a>
            </li>
            <li>
              <a href="#memos">
                <span>Memos</span>
                <span class="report-counts">{listed}</span>
              </a>
            </li>
            <li>
              <a href="#tweaks">
                <span>Tweaks</span>
                <span class="report-counts">{String(view.tweaks.length)}</span>
              </a>
            </li>
          </ul>
        </nav>
      )}
      <section class="form-section">
        <h2 id="cover-sheet">Cover sheet</h2>
        <p class="applies">
          Your voice guide, served first to every AI. Keep it to short, hard
          things your memos can’t show: “no em dashes”, “sign off –P”. Only you
          write it, by telling your AI the exact words.
        </p>
        {/* Read only: AIs change it on the person's words (docs/memos.md).
            One ruled line per line as written, blank lines included. */}
        {view.cover_sheet.text.trim() ? (
          <>
            <div class="cover-lines">
              {view.cover_sheet.text.split("\n").map((line) => (
                <p class="line">
                  <span class="typed">{line}</span>
                </p>
              ))}
            </div>
            <p class="small-note">
              To change it, tell an AI you connected with Read and write which
              line to add or remove.
            </p>
          </>
        ) : (
          <>
            <p class="report-counts">No cover sheet yet.</p>
            <p class="small-note">
              To start one, tell an AI you connected with Read and write: “Add
              to my cover sheet: no em dashes.”
            </p>
          </>
        )}
      </section>
      <section class="form-section">
        <h2 id="scoreboard">Scoreboard</h2>
        <p class="applies">
          How much your first drafts needed, now against your first memos. Draft
          and edit memos count apart; your own writing isn’t scored.
        </p>
        <ul class="score-lines">
          {view.scoreboard.map((score) => (
            <li class="line">
              <span class="typed">{scoreboardLine(score)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section class="form-section">
        <h2 id="memos">Memos</h2>
        <p class="applies">
          {view.keep_memos
            ? "Newest first. Your AI keeps one each time you accept a final."
            : "Newest first. Keep memos is off: your AI keeps one only when you say “remember this”."}{" "}
          <a href="/account/memos">Memo settings</a>
        </p>
        {notices.memos}
        {view.memos.length === 0 ? (
          <p class="report-counts">No memos yet.</p>
        ) : (
          <ol class="memo-list">
            {view.memos.map((m) => (
              <li class="memo-row">
                <p class="memo-head">
                  <span class="memo-label">{memoLabel(m)}</span>
                  <span class="report-counts">{when(m.at)}</span>
                </p>
                <p class="typed">{m.summary}</p>
                {askedLine(m)}
                <p class="report-counts">
                  {[
                    clientLabel(m.client),
                    roundsLabel(m),
                    m.change_count
                      ? counted(m.change_count, "listed change")
                      : "",
                    TIER[m.tier],
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {tweakList("Served", m.served)}
                {tweakList("Taught", m.taught)}
                <div class="memo-actions">
                  <a href={`/tps/memo/${m.id}`}>Open memo</a>
                  {forgetForm(csrf, m)}
                </div>
              </li>
            ))}
          </ol>
        )}
        {view.memos.length >= LISTED_MEMOS && (
          <p class="small-note">
            This page lists your newest {LISTED_MEMOS} memos.{" "}
            <a href="/download">TPS.md</a> has every final.
          </p>
        )}
      </section>
      <section class="form-section">
        <h2 id="tweaks">Tweaks</h2>
        <p class="applies">
          What you made your AIs change, one line each, with how many memos
          taught it. The next AI gets the ones from your closest memos. “Served”
          counts drafts an AI was given a tweak for; “needed again”, how many of
          those you still had to fix the same way.
        </p>
        {notices.tweaks}
        {view.tweaks.length === 0 ? (
          <p class="report-counts">No tweaks yet.</p>
        ) : (
          <ul class="tweak-list">
            {view.tweaks.map((t) => (
              <li class="tweak-row">
                <p>
                  <span class="typed">{t.text}</span>
                </p>
                <p class="report-counts tweak-counts">
                  <span>{counted(t.memos, "memo")}</span>
                  {t.served > 0 && (
                    <>
                      <span>served {String(t.served)}</span>
                      <span>needed again {String(t.needed_again)}</span>
                    </>
                  )}
                </p>
                <div class="memo-actions">
                  <form method="post" action="/tps/tweaks/delete">
                    {csrf()}
                    <input type="hidden" name="tweak" value={t.id} />
                    <button
                      class="secondary compact"
                      aria-label={`Delete tweak: ${t.text}`}
                    >
                      Delete
                    </button>
                  </form>
                  <details class="tweak-reword">
                    <summary>Reword</summary>
                    <form method="post" action="/tps/tweaks/reword">
                      {csrf()}
                      <input type="hidden" name="tweak" value={t.id} />
                      <label>
                        New wording
                        <input
                          name="text"
                          value={t.text}
                          maxlength={200}
                          required
                          autocomplete="off"
                        />
                      </label>
                      <button class="compact">Save wording</button>
                    </form>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
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

const chrome = (
  ctx: MemoPageContext,
  billing?: BillingItem,
  here?: "report",
) => ({
  account: { csrf: ctx.csrf, email: ctx.email, here, billing },
});

async function tpsPage(
  store: PageStore,
  ctx: MemoPageContext,
  notices: Notices = {},
) {
  // Two independent reads at once, each on its own pooled connection. Billing
  // information is page chrome, never part of the report or download.
  const [view, trial] = await Promise.all([
    store.read(),
    store.trialStatus?.().catch(() => undefined),
  ]);
  const paused = trial?.status === "expired";
  const empty = !view.cover_sheet.text && view.memos.length === 0;
  return page(
    "TPS report",
    <>
      {billingNote(ctx.csrf, ctx.billing ?? false, trial)}
      {!empty && !paused && (
        <p class="small-note sheet-meta">
          When you accept a final from a connected AI, it keeps a memo here. The
          next AI reads your cover sheet and your closest memos before it
          drafts.
        </p>
      )}
      {sheet({
        view,
        email: ctx.email,
        date: (ctx.now?.() ?? new Date()).toISOString().slice(0, 10),
        comment: (ctx.comment ?? randomComment)(),
        csrf: ctx.csrf,
        notices,
      })}
    </>,
    200,
    null,
    {
      ...chrome(ctx, ctx.billing ? billingItem(trial) : undefined, "report"),
      sheet: true,
    },
  );
}

const backLink = (
  <p>
    <a href="/">Back to your TPS report</a>
  </p>
);
const notFound = (ctx: MemoPageContext, message: string) =>
  page(
    "Not found",
    <>
      <p>{message}</p>
      {backLink}
    </>,
    404,
    null,
    { ...chrome(ctx), wide: true },
  );

/** One side of a change, verbatim; "…" where it was cut at 300 characters. */
const side = (text: string, c: TpsChange) => (
  <span class="typed">{`“${text}${c.truncated && Array.from(text).length >= 300 ? "…" : ""}”`}</span>
);
/** One spot code found, unlabelled: before → after, or added or cut when a
 * side is empty; a Markdown-only spot says "formatting", and a cut side says
 * so (docs/memos.md, "Changes"). */
const changeRow = (c: TpsChange) => {
  const notes = [
    ...(c.about === "format" ? ["formatting"] : []),
    ...(c.truncated ? ["shortened to 300 characters"] : []),
  ];
  return (
    <li class="change-row">
      <p>
        {!c.before ? (
          <>added: {side(c.after, c)}</>
        ) : !c.after ? (
          <>cut: {side(c.before, c)}</>
        ) : (
          <>
            {side(c.before, c)} → {side(c.after, c)}
          </>
        )}
      </p>
      {notes.length > 0 && (
        <p class="report-counts change-notes">
          {notes.map((note) => (
            <span>{note}</span>
          ))}
        </p>
      )}
    </li>
  );
};
/** "What changed": code's own list, for a memo saved since it was kept. */
function whatChanged(m: FullMemo) {
  if (!m.changes_state) return null;
  return (
    <section aria-labelledby="memo-changes">
      <h2 id="memo-changes">What changed</h2>
      {m.changes_state === "too_large" ? (
        <p class="small-note">
          Too many changes to list; the first draft and final above show them
          all.
        </p>
      ) : m.changes.length ? (
        <>
          <ol class="change-list">{m.changes.map(changeRow)}</ol>
          {m.changes_served && (
            // True by the report's own rule (docs/reports.md); a report's
            // budget may still leave them out, hence "may".
            <p class="small-note">
              Your AIs may see a few of these changes when this memo is used as
              an example.
            </p>
          )}
        </>
      ) : m.first_draft === m.final ? (
        <p class="small-note">
          Nothing: you accepted the first draft as it was.
        </p>
      ) : (
        // The diff compares words and marks, so an edit of spacing or line
        // breaks alone lists nothing; the texts still differ.
        <p class="small-note">
          Only spacing or line breaks changed; compare the first draft and final
          above.
        </p>
      )}
    </section>
  );
}

/** The full memo: both texts word for word, its context and its tweaks. */
function memoPage(ctx: MemoPageContext, m: FullMemo, notice?: Child) {
  const facts: [string, Child][] = [
    ["Medium", MEDIUM[m.medium]],
    ...(m.kind ? [["Kind", m.kind] as [string, Child]] : []),
    ["Date", when(m.at)],
    ["From", clientLabel(m.client)],
    [
      "Mode",
      m.mode === "draft"
        ? "Drafted by your AI"
        : m.mode === "edit"
          ? "Your text, edited by your AI"
          : "Your own writing",
    ],
    ...(m.rounds !== undefined
      ? [["Rounds", String(m.rounds)] as [string, Child]]
      : []),
    ...(m.change !== undefined
      ? [["Changed", percent(m.change)] as [string, Child]]
      : []),
    ["Tier", TIER[m.tier]],
  ];
  const tweaks = (list: { text: string }[], none: string) =>
    list.length ? (
      <ul class="memo-tweak-list">
        {list.map((t) => (
          <li>{t.text}</li>
        ))}
      </ul>
    ) : (
      <p class="small-note">{none}</p>
    );
  return page(
    "Memo",
    <>
      {backLink}
      <p class="memo-label">{memoLabel(m)}</p>
      <dl class="memo-facts">
        {facts.map(([label, value]) => (
          <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="memo-context">
        <h2 id="memo-context">Context</h2>
        <p>{m.summary}</p>
        {(m.audience || m.purpose) && (
          <dl class="memo-facts">
            {m.audience && (
              <div>
                <dt>Audience</dt>
                <dd>{m.audience}</dd>
              </div>
            )}
            {m.purpose && (
              <div>
                <dt>Purpose</dt>
                <dd>{m.purpose}</dd>
              </div>
            )}
          </dl>
        )}
      </section>
      {(m.request !== undefined || notice) && (
        <section aria-labelledby="memo-asked">
          <h2 id="memo-asked">You asked</h2>
          {notice}
          {m.request !== undefined && (
            <>
              {plain(m.request)}
              <p class="small-note">
                What your AI kept as your ask for this; it is asked to keep only
                what you typed. Shown only to you, never sent to an AI.
              </p>
              <form method="post" action="/tps/request/remove">
                {ctx.csrf()}
                <input type="hidden" name="memo" value={m.id} />
                <button class="secondary">Remove</button>
              </form>
            </>
          )}
        </section>
      )}
      <section aria-labelledby="memo-first">
        <h2 id="memo-first">First draft</h2>
        {m.first_draft !== undefined ? (
          plain(m.first_draft)
        ) : m.first_draft_state === "missing" ? (
          <p class="small-note">
            First draft missing: your AI no longer had it word for word, so it
            kept the final alone.
          </p>
        ) : (
          <p class="small-note">Your own writing: there’s no first draft.</p>
        )}
      </section>
      <section aria-labelledby="memo-final">
        <h2 id="memo-final">Final</h2>
        {plain(m.final)}
      </section>
      {whatChanged(m)}
      <section aria-labelledby="memo-served">
        <h2 id="memo-served">Served tweaks</h2>
        {tweaks(m.served, "No tweaks were served for this memo.")}
      </section>
      <section aria-labelledby="memo-taught">
        <h2 id="memo-taught">Taught tweaks</h2>
        {tweaks(m.taught, "This memo taught no tweaks.")}
      </section>
      <section aria-labelledby="memo-forget">
        <h2 id="memo-forget">Forget this memo</h2>
        <p>
          Removes the memo, what you asked, its changes, its example and its
          tweak citations. A tweak no other memo taught goes too.
        </p>
        <form method="post" action="/tps/forget">
          {ctx.csrf()}
          <input type="hidden" name="memo" value={m.id} />
          <button class="secondary">Forget this memo</button>
        </form>
      </section>
    </>,
    200,
    null,
    { ...chrome(ctx), wide: true },
  );
}

export async function memoPages(
  request: Request,
  store: PageStore,
  ctx: MemoPageContext,
): Promise<Response> {
  // Reached only with the method memoMethod names for a TPS route: the
  // browser router answers every other path and method first.
  const url = new URL(request.url);
  const path = url.pathname;
  const back = (done: Done, anchor: string) =>
    Response.redirect(`${ctx.appOrigin}/?done=${done}#${anchor}`, 303);
  if (path === "/download")
    return new Response(await store.exportTps(), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="TPS.md"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  const memoId = MEMO_PATH.exec(path)?.[1];
  if (memoId !== undefined) {
    const found = ID.test(memoId) ? await store.readMemo(memoId) : undefined;
    return found
      ? memoPage(
          ctx,
          found,
          url.searchParams.get("done") === "request-removed" ? (
            <p role="status">Request removed.</p>
          ) : undefined,
        )
      : notFound(ctx, "This memo is forgotten or does not exist.");
  }
  if (request.method === "POST") {
    const form = await ctx.readForm();
    const id = (name: string) => {
      const value = form.get(name) ?? "";
      return ID.test(value) ? value : undefined;
    };
    if (path === "/tps/forget") {
      const memo = id("memo");
      if (!memo || !(await store.forgetMemo(memo)))
        return notFound(
          ctx,
          "This memo is already forgotten or does not exist.",
        );
      return back("forgot", "memos");
    }
    if (path === "/tps/request/remove") {
      const memo = id("memo");
      if (!memo || !(await store.removeRequest(memo)))
        return notFound(ctx, "This memo is forgotten or does not exist.");
      return Response.redirect(
        `${ctx.appOrigin}/tps/memo/${memo}?done=request-removed#memo-asked`,
        303,
      );
    }
    const tweak = id("tweak");
    if (path === "/tps/tweaks/delete") {
      if (!tweak || !(await store.deleteTweak(tweak)))
        return notFound(
          ctx,
          "This tweak is already deleted or does not exist.",
        );
      return back("tweak-deleted", "tweaks");
    }
    // /tps/tweaks/reword
    if (!tweak || !(await store.rewordTweak(tweak, form.get("text") ?? "")))
      return notFound(ctx, "This tweak is deleted or does not exist.");
    return back("tweak-reworded", "tweaks");
  }
  const done = url.searchParams.get("done");
  const notice =
    done !== null && Object.hasOwn(NOTICES, done)
      ? NOTICES[done as Done]
      : undefined;
  return tpsPage(
    store,
    ctx,
    notice ? { [notice[0]]: <p role="status">{notice[1]}</p> } : {},
  );
}
