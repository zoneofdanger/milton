/** @jsxImportSource hono/jsx */
import { billingItem, page, type BillingItem } from "./pages";
import type { Child } from "hono/jsx";
import { StoreError, type PersonStore } from "./store";
import type { TrialStatus } from "./store/trials";
import type { FullMemo, TpsMemo, TpsView } from "./store/tps";
import { LISTED_MEMOS } from "./store/tps";
import { COVER_SHEET_CHARS } from "./store/memos";
import { SCOREBOARD_MIN, type Scoreboard, type ScoreLine } from "./store/score";
import { SETUP_PROMPT } from "@milton/theme/setup-prompt";
import { clientHost } from "./auth-assistants";

// The TPS page's routes. "/" also serves the signed-out landing page, so the
// browser router sends it here only for a signed-in person.
const GETS = ["/", "/download", "/tps-report"];
const POSTS = [
  "/tps/cover-sheet",
  "/tps/forget",
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
  | "saveCoverSheet"
  | "forgetMemo"
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
          Your account starts empty; start by pasting about five things you
          wrote and sent.
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
  "cover-saved": ["cover", "Cover sheet saved."],
  "cover-unchanged": ["cover", "Cover sheet unchanged."],
  forgot: ["memos", "Memo forgotten."],
  "tweak-deleted": ["tweaks", "Tweak deleted."],
  "tweak-reworded": ["tweaks", "Tweak reworded."],
} as const;
type Done = keyof typeof NOTICES;
type Notices = Partial<Record<"cover" | "memos" | "tweaks", Child>>;

/** What the cover sheet form shows: the saved text by default, or after a
 * refusal what the person typed (too long) or the current text (changed
 * elsewhere), with the version to send next. */
type CoverForm = { text: string; version: number };

type SheetView = {
  view: TpsView;
  email?: string;
  date: string;
  comment: string;
  csrf: () => Child;
  cover: CoverForm;
  notices: Notices;
};
/** The signed-in TPS report as a printed form: the cover sheet and its form,
 * the scoreboard, the memos newest first and the person's tweaks. */
function sheet({
  view,
  email,
  date,
  comment,
  csrf,
  cover,
  notices,
}: SheetView) {
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
            an AI, then paste about five things you wrote and sent. Your AI
            keeps each as a memo here.
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
          write it, here or by telling your AI the exact words.
        </p>
        {notices.cover}
        <form method="post" action="/tps/cover-sheet" class="cover-form">
          {csrf()}
          <input
            type="hidden"
            name="expected_version"
            value={String(cover.version)}
          />
          <label for="cover-sheet-text">
            Cover sheet text
            <span class="small-note">
              Up to {COVER_SHEET_CHARS.toLocaleString("en-US")} characters.
            </span>
          </label>
          {/* The leading newline is the one HTML drops, so a cover sheet that
              starts with a blank line keeps it. */}
          <textarea
            id="cover-sheet-text"
            name="text"
            rows={8}
            maxlength={COVER_SHEET_CHARS}
          >
            {"\n" + cover.text}
          </textarea>
          <button>Save cover sheet</button>
        </form>
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
                <p class="report-counts">
                  {[clientLabel(m.client), roundsLabel(m), TIER[m.tier]]
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
          taught it. The next AI gets the ones from your closest memos.
        </p>
        {notices.tweaks}
        {view.tweaks.length === 0 ? (
          <p class="report-counts">No tweaks yet.</p>
        ) : (
          <ul class="tweak-list">
            {view.tweaks.map((t) => (
              <li class="tweak-row">
                <p>
                  <span class="typed">{t.text}</span>{" "}
                  <span class="report-counts">{counted(t.memos, "memo")}</span>
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
  {
    cover,
    notices = {},
    code = 200,
  }: {
    cover?: (view: TpsView) => CoverForm;
    notices?: Notices;
    code?: number;
  } = {},
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
        cover: cover?.(view) ?? view.cover_sheet,
        notices,
      })}
    </>,
    code,
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

/** The full memo: both texts word for word, its context and its tweaks. */
function memoPage(ctx: MemoPageContext, m: FullMemo) {
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
          Removes the memo, its example and its tweak citations. A tweak no
          other memo taught goes too.
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
      ? memoPage(ctx, found)
      : notFound(ctx, "This memo is forgotten or does not exist.");
  }
  if (request.method === "POST") {
    const form = await ctx.readForm();
    const id = (name: string) => {
      const value = form.get(name) ?? "";
      return ID.test(value) ? value : undefined;
    };
    if (path === "/tps/cover-sheet") {
      const text = form.get("text") ?? "";
      const expected = Number(form.get("expected_version"));
      if (!Number.isInteger(expected) || expected < 0)
        throw new StoreError(
          "invalid_input",
          "Reload the page before saving your cover sheet. Nothing was saved.",
          400,
        );
      let saved: Awaited<ReturnType<PageStore["saveCoverSheet"]>>;
      try {
        saved = await store.saveCoverSheet(text, expected);
      } catch (error) {
        if (
          !(error instanceof StoreError) ||
          error.code !== "cover_sheet_limit"
        )
          throw error;
        // What the person typed stays in the form to shorten.
        return tpsPage(store, ctx, {
          code: 422,
          cover: () => ({ text, version: expected }),
          notices: { cover: <p role="alert">{error.message}</p> },
        });
      }
      if (saved.status === "conflict")
        // Never overwrite: show the current text, and what they typed to copy.
        return tpsPage(store, ctx, {
          code: 409,
          notices: {
            cover: (
              <div role="alert">
                <p>
                  Your cover sheet changed elsewhere, by an AI or another tab,
                  after you opened this page. Nothing was saved. The form now
                  holds the current text; your text is below to copy.
                </p>
                {plain(text)}
              </div>
            ),
          },
        });
      return back(
        saved.status === "saved" ? "cover-saved" : "cover-unchanged",
        "cover-sheet",
      );
    }
    if (path === "/tps/forget") {
      const memo = id("memo");
      if (!memo || !(await store.forgetMemo(memo)))
        return notFound(
          ctx,
          "This memo is already forgotten or does not exist.",
        );
      return back("forgot", "memos");
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
  return tpsPage(store, ctx, {
    notices: notice ? { [notice[0]]: <p role="status">{notice[1]}</p> } : {},
  });
}
