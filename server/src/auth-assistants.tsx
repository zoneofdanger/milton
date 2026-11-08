/** @jsxImportSource hono/jsx */
import { page } from "./pages";
import { connectSteps } from "./memo-pages";
import { cookieValue, type PageContext } from "./auth-session";
import { cookieName } from "./auth-oidc";
import { connections, lifecycle, type Operation } from "./auth-lifecycle";
import { accountKeys, keysSection } from "./auth-keys";
import { supportEmail } from "./config";
import { inOrder } from "./http";

export const clientHost = (clientId: string) => {
  try {
    const id = new URL(clientId);
    if (id.protocol === "https:") return id.host;
  } catch {}
  return "";
};
export const assistants = async (ctx: PageContext): Promise<Response> => {
  const { config, request, url, csrfField, readForm, signedIn } = ctx;
  if (
    request.method !==
    (url.pathname === "/assistants/disconnect" ? "POST" : "GET")
  )
    return page(
      "Method not allowed",
      <p>Use the page's controls to continue.</p>,
      405,
    );
  const token = cookieValue(request, cookieName(config, "session"));
  const disconnects = lifecycle({ ...ctx, token });
  /** The incomplete disconnect `op`, with a form that retries it. */
  const retry = (op: Operation) => (
    <>
      <p>
        Disconnect cleanup is incomplete. Retry to finish disconnecting{" "}
        {clientHost(op.client_id) || op.client_id}.
      </p>
      <form method="post" action="/assistants/disconnect">
        {csrfField()}
        <input type="hidden" name="operation" value={op.operation_id} />
        <button>Retry disconnect</button>
      </form>
    </>
  );
  if (request.method === "POST") {
    const form = await readForm();
    const { operation, failed } = await disconnects.run(
      "disconnect",
      form.get("operation") ?? "",
      form.get("connection"),
    );
    if (failed || operation.progress !== "complete")
      return page(
        "Finish disconnecting",
        <>
          {retry(operation)}
          <p>
            If retry does not finish, contact{" "}
            <a href={`mailto:${supportEmail(config)}`}>
              {supportEmail(config)}
            </a>
            .
          </p>
        </>,
        503,
      );
    return Response.redirect(config.appOrigin + "/assistants", 303);
  }
  const user = await signedIn();
  // Each read borrows its own pooled connection; none borrows while holding one.
  const [{ items: listed, full }, pending, keys, billing] = await inOrder(
    connections(config, user),
    disconnects.pending("disconnect"),
    accountKeys(ctx, user).then((account) => account.list()),
    ctx.accountBilling(user),
  );
  return page(
    "Connected assistants",
    <>
      {connectSteps(false, config.resource)}
      <p>
        Each assistant has the access you chose. Disconnecting ends its current
        access immediately. To use it again, reconnect from the assistant.
      </p>
      {pending.map((op) => (
        <section>{retry(op)}</section>
      ))}
      {full && (
        <p>
          This connection list is incomplete. Disconnect a listed assistant and
          reload; if none is listed, sign-in session cleanup is needed before
          all assistants can be shown.
        </p>
      )}
      {listed.length === 0 ? (
        <p>
          {full
            ? "No assistants are shown in this part of the list."
            : "No assistants are connected."}
        </p>
      ) : (
        <ul class="assistant-list">
          {listed.map((c) => (
            <li>
              <p>
                <strong>{clientHost(c.client_id) || c.client_id}</strong>
              </p>
              <p>
                {c.scopes.includes("milton:write")
                  ? "Read and write"
                  : "Read only"}
              </p>
              <form method="post" action="/assistants/disconnect">
                {csrfField()}
                <input type="hidden" name="connection" value={c.reference} />
                <input
                  type="hidden"
                  name="operation"
                  value={crypto.randomUUID()}
                />
                <button class="secondary">Disconnect</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {keysSection(keys, csrfField)}
    </>,
    200,
    null,
    {
      account: {
        csrf: csrfField,
        email: user.email,
        here: "assistants",
        billing,
      },
    },
  );
};
