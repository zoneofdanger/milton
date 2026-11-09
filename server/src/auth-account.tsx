/** @jsxImportSource hono/jsx */
import { page } from "./pages";
import { cookieValue, type PageContext } from "./auth-session";
import { cookieName, removeSession } from "./auth-oidc";
import { lifecycle, type Operation } from "./auth-lifecycle";
import { supportEmail } from "./config";
import { personStoreForCurrentRequest, StoreError } from "./store";

const phrase = "delete my account";
export const accountDeletion = async (ctx: PageContext): Promise<Response> => {
  const { config, request, csrfField, readForm, signedIn, writeCookie } = ctx;
  if (!["GET", "POST"].includes(request.method))
    return page(
      "Method not allowed",
      <p>Use the page's controls to continue.</p>,
      405,
    );
  const token = cookieValue(request, cookieName(config, "session"));
  const deletion = lifecycle({ ...ctx, token });
  const retryPage = (op: Operation) =>
    page(
      "Finish account deletion",
      <>
        <p>
          {op.progress === "pending"
            ? "Account deletion has not been confirmed. Retry to continue this original request."
            : "Account deletion is incomplete. Access has been stopped. Retry to finish deleting this original account."}
        </p>
        {op.progress === "writing-erased" && (
          <p>
            Your writing has been erased. Sign-in cleanup still needs to finish.
          </p>
        )}
        <form method="post" action="/account/delete">
          {csrfField()}
          <input type="hidden" name="operation" value={op.operation_id} />
          <input type="hidden" name="confirm" value={phrase} />
          <button>Retry deletion</button>
        </form>
        <p>
          If retry does not finish, contact{" "}
          <a href={`mailto:${supportEmail(config)}`}>{supportEmail(config)}</a>.
        </p>
      </>,
      503,
    );
  if (request.method === "GET") {
    const [pending] = await deletion.pending("delete");
    if (pending) return retryPage(pending);
    const user = await signedIn();
    return page(
      "Delete your account",
      <>
        <p>
          Deleting your Milton account cannot be undone.{" "}
          <a href="/download">Download TPS.md</a> first to keep a copy.
        </p>
        <p>
          Your memos, tweaks, cover sheet, receipts and usage counters are
          deleted. Your subscription ends immediately, with no refund. Connected
          AIs lose access, and your sign-in methods and browser sessions are
          removed after cleanup finishes.
        </p>
        <p>
          Milton keeps minimal one-way identity fingerprints to prevent another
          free trial, original disconnect/deletion records to make retries safe,
          Stripe's past payment records and copies until backups expire.
        </p>
        <form method="post" action="/account/delete">
          {csrfField()}
          <input type="hidden" name="operation" value={crypto.randomUUID()} />
          <label>
            Type <code>{phrase}</code> to confirm.
            <input
              name="confirm"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              required
            />
          </label>
          <button class="secondary">Delete my account</button>
        </form>
      </>,
      200,
      null,
      {
        account: {
          csrf: csrfField,
          email: user.email,
          billing: await ctx.accountBilling(user),
        },
      },
    );
  }
  const form = await readForm();
  if (form.get("confirm") !== phrase)
    return page(
      "Confirmation required",
      <p>Type {phrase} exactly. Nothing was deleted.</p>,
      400,
    );
  const { operation, failed } = await deletion.run(
    "delete",
    form.get("operation") ?? "",
  );
  if (failed || operation.progress !== "complete") return retryPage(operation);
  await removeSession(config, token);
  writeCookie(cookieName(config, "session"), "", 0);
  writeCookie(ctx.csrfName, "", 0);
  return page(
    "Account deleted",
    <>
      <p role="status">
        Your Milton account and sign-in have been deleted. Your writing is
        erased, your subscription has ended, and connected AIs have lost access.
      </p>
      <p>
        Stripe keeps past payment records. Backup copies expire according to
        their retention schedule. Minimal fingerprints and original security
        operation records remain to prevent another trial and keep retries safe.
      </p>
      <p>
        <a href="/">Milton home</a>
      </p>
    </>,
  );
};

export const isMemoSettingsRoute = (path: string) =>
  path === "/account/memos" || path === "/account/memos/delete";
const deleteAll = "delete all memos";
const MEMO_NOTICES = {
  on: "Keep memos is on.",
  off: "Keep memos is off.",
  deleted: "All memos and tweaks are deleted. Your cover sheet is unchanged.",
} as const;

/** GET and POST /account/memos: the Keep memos switch. GET
 * /account/memos/delete confirms, and its POST deletes every memo, tweak and
 * kind; the cover sheet stays. */
export const memoSettings = async (ctx: PageContext): Promise<Response> => {
  const { config, request, url, csrfField, readForm, signedIn } = ctx;
  if (!["GET", "POST"].includes(request.method))
    return page(
      "Method not allowed",
      <p>Use the page's controls to continue.</p>,
      405,
    );
  const form = request.method === "POST" ? await readForm() : undefined;
  const user = await signedIn();
  const store = personStoreForCurrentRequest(config, await ctx.account(user));
  const back = (done: keyof typeof MEMO_NOTICES) =>
    Response.redirect(`${config.appOrigin}/account/memos?done=${done}`, 303);
  if (form && url.pathname === "/account/memos") {
    const keep = form.get("keep");
    if (keep !== "on" && keep !== "off")
      throw new StoreError(
        "invalid_input",
        "Choose on or off. Nothing was changed.",
        400,
      );
    await store.setKeepMemos(keep === "on");
    return back(keep);
  }
  if (form) {
    if (form.get("confirm") !== deleteAll)
      return page(
        "Confirmation required",
        <>
          <p>Confirm from the delete page. Nothing was deleted.</p>
          <p>
            <a href="/account/memos">Back to memo settings</a>
          </p>
        </>,
        400,
      );
    await store.deleteAllMemos();
    return back("deleted");
  }
  const [view, billing] = await Promise.all([
    store.read(),
    ctx.accountBilling(user),
  ]);
  const chrome = {
    account: { csrf: csrfField, email: user.email, billing },
  };
  if (url.pathname === "/account/memos/delete")
    return page(
      "Delete all memos?",
      <>
        <p>
          This deletes every memo, every tweak and every kind on your account.
          Your cover sheet stays. It cannot be undone.{" "}
          <a href="/download">Download TPS.md</a> first to keep a copy.
        </p>
        <form method="post" action="/account/memos/delete">
          {csrfField()}
          <input type="hidden" name="confirm" value={deleteAll} />
          <div class="action-row">
            <button>Delete all memos</button>
            <a class="button secondary" href="/account/memos">
              Cancel
            </a>
          </div>
        </form>
      </>,
      200,
      null,
      chrome,
    );
  const done = url.searchParams.get("done");
  return page(
    "Memo settings",
    <>
      {done !== null && Object.hasOwn(MEMO_NOTICES, done) && (
        <p role="status">{MEMO_NOTICES[done as keyof typeof MEMO_NOTICES]}</p>
      )}
      <section aria-labelledby="keep-memos-h">
        <h2 id="keep-memos-h">Keep memos</h2>
        <p>
          <strong>{view.keep_memos ? "On." : "Off."}</strong>{" "}
          {view.keep_memos
            ? "Each time you accept a final, your AI keeps a memo: its first draft, your final and the tweaks between them."
            : "Your AIs keep no memos on their own. You can still say “remember this” to keep one."}
        </p>
        {view.keep_memos && (
          <p class="small-note">
            Turning it off stops automatic memos. Saying “remember this” still
            keeps one, and the memos you have stay until you forget or delete
            them.
          </p>
        )}
        <form method="post" action="/account/memos">
          {csrfField()}
          <input
            type="hidden"
            name="keep"
            value={view.keep_memos ? "off" : "on"}
          />
          <button class="secondary">
            {view.keep_memos ? "Turn off Keep memos" : "Turn on Keep memos"}
          </button>
        </form>
      </section>
      <section aria-labelledby="delete-memos-h">
        <h2 id="delete-memos-h">Delete all memos</h2>
        <p>
          Deletes every memo, tweak and kind. Your cover sheet stays, and you
          can forget one memo at a time from{" "}
          <a href="/#memos">your TPS report</a>.
        </p>
        <p>
          <a class="button secondary" href="/account/memos/delete">
            Delete all memos…
          </a>
        </p>
      </section>
    </>,
    200,
    null,
    chrome,
  );
};
