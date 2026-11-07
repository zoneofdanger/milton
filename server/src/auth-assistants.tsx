/** @jsxImportSource hono/jsx */
import { page } from "./pages";
import { connectSteps } from "./memo-pages";
import { cookieValue, type PageContext } from "./auth-session";
import { cookieName } from "./auth-oidc";
import { connections, lifecycle } from "./auth-lifecycle";
import { accountKeys, keysSection } from "./auth-keys";

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
  if (request.method === "POST") {
    const form = await readForm();
    await disconnects.run(
      "disconnect",
      form.get("operation") ?? "",
      form.get("connection"),
    );
    return Response.redirect(config.appOrigin + "/assistants", 303);
  }
  const user = await signedIn();
  const { items: listed, full } = await connections(config, user);
  const pending = await disconnects.pending("disconnect");
  const keys = await (await accountKeys(ctx, user)).list();
  return page(
    "Connected assistants",
    <>
      {connectSteps(false, config.resource)}
      <p>
        Each assistant has the access you chose. Disconnecting ends its current
        access immediately. To use it again, reconnect from the assistant.
      </p>
      {pending.map((op) => (
        <section>
          <p>
            Disconnect cleanup is incomplete. Retry to finish disconnecting{" "}
            {clientHost(op.client_id) || op.client_id}.
          </p>
          <form method="post" action="/assistants/disconnect">
            {csrfField()}
            <input type="hidden" name="operation" value={op.operation_id} />
            <button>Retry disconnect</button>
          </form>
        </section>
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
        billing: await ctx.accountBilling(user),
      },
    },
  );
};
