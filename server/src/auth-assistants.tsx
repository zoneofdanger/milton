/** @jsxImportSource hono/jsx */
import { page } from "./pages";
import { connectSteps } from "./memo-pages";
import { cookieValue, type PageContext } from "./auth-session";
import { cookieName } from "./auth-oidc";
import {
  advanceOperation,
  connections,
  findOperation,
  startOperation,
  pendingOperations,
} from "./auth-lifecycle";
import { invalid } from "./auth-authority";
import { accountKeys, keysSection } from "./auth-keys";

export const clientHost = (clientId: string) => {
  try {
    const id = new URL(clientId);
    if (id.protocol === "https:") return id.host;
  } catch {}
  return "";
};
/** Awaits reads started together, each borrowing its own pooled connection
 * (none borrows while holding one), and fails as awaiting them one after
 * another would: with the first listed failure. */
const inOrder = async <T extends readonly unknown[]>(
  ...reads: { [K in keyof T]: Promise<T[K]> }
): Promise<T> => {
  const settled = await Promise.allSettled(reads);
  for (const read of settled) if (read.status === "rejected") throw read.reason;
  return settled.map(
    (read) => (read as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
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
  if (request.method === "POST") {
    const form = await readForm();
    const token = cookieValue(request, cookieName(config, "session"));
    const id = form.get("operation") ?? "";
    let op = await findOperation(config, token, id, "disconnect");
    if (!op) {
      const user = await signedIn();
      const { items: listed } = await connections(config, user);
      const target = listed.find((c) => c.reference === form.get("connection"));
      if (!target || !token) throw invalid();
      op = await startOperation(
        config,
        user,
        token,
        id,
        "disconnect",
        target.client_id,
      );
    }
    await advanceOperation(config, op);
    return Response.redirect(config.appOrigin + "/assistants", 303);
  }
  const user = await signedIn();
  const [{ items: listed, full }, pending, keys, billing] = await inOrder(
    connections(config, user),
    pendingOperations(
      config,
      cookieValue(request, cookieName(config, "session")),
    ),
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
        billing,
      },
    },
  );
};
