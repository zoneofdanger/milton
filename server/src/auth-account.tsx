/** @jsxImportSource hono/jsx */
import { page } from "./pages";
import { cookieValue, type PageContext } from "./auth-session";
import { cookieName, removeSession } from "./auth-oidc";
import { lifecycle, type Operation } from "./auth-lifecycle";
import { supportEmail } from "./config";

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
          Your rules, approved samples, report history, receipts and usage
          counters are deleted. Your subscription ends immediately, with no
          refund. Connected AIs lose access, and your sign-in methods and
          browser sessions are removed after cleanup finishes.
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
        erased, your subscription has ended, and connected AIs have lost
        access.
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
