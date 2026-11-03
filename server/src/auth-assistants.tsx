/** @jsxImportSource hono/jsx */
import { z } from "zod";
import type { Child } from "hono/jsx";
import {
  listAssistantDisconnects,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  recordAssistantDisconnect,
} from "./store";
import { connectSteps } from "./memo-pages";
import { AuthError } from "./token";
import { page } from "./pages";
import { timed, type PageContext, type SessionUser } from "./auth-session";

export const consentList = z.array(
  z.object({
    id: z.string().min(1).max(512),
    clientId: z.string().min(1).max(2048),
    userId: z.string(),
    createdAt: z.coerce.date(),
  }),
);
// Name lookups per page view; later rows show the client id unverified.
const NAMED_ASSISTANTS = 20;
export const clientHost = (clientId: string) => {
  try {
    const id = new URL(clientId);
    if (id.protocol === "https:") return id.host;
  } catch {
    /* DCR ids are not URLs. */
  }
  return "";
};
const assistantsUnavailable = () =>
  new AuthError(
    "assistants_unavailable",
    "Connected assistants are unavailable right now. Try again.",
    503,
  );
// Always the live list from Neon for this session; never a cached copy.
export const readConsents = async (ctx: PageContext, user: SessionUser) => {
  const { auth } = ctx;
  let result: Awaited<ReturnType<typeof auth.oauth2.getConsents>>;
  try {
    result = await timed(auth.oauth2.getConsents());
  } catch {
    throw assistantsUnavailable();
  }
  if (result.error?.status === 401)
    throw new AuthError(
      "session_required",
      "Sign in to Milton before continuing.",
      403,
    );
  const parsed = consentList.safeParse(result.data);
  if (result.error || !parsed.success) throw assistantsUnavailable();
  return parsed.data.filter((consent) => consent.userId === user.id);
};
const clientName = async (ctx: PageContext, clientId: string) => {
  const { auth } = ctx;
  try {
    const result = await timed(
      auth.oauth2.publicClient({ query: { client_id: clientId } }),
    );
    const client = z
      .object({ client_name: z.string().optional() })
      .safeParse(result.data);
    return !result.error && client.success
      ? client.data.client_name
      : undefined;
  } catch {
    return undefined;
  }
};
// Picks the setup prompt only, so a failed read shows the general prompt.
const accountEmpty = async ({ config }: PageContext, user: SessionUser) => {
  try {
    const verified = await lookupIdentityAccount(config, {
      provider: "neon",
      subject: user.id,
    });
    const store = await personStoreForCurrentRequest(config, verified);
    return (await store.readTpsReport()).is_empty;
  } catch {
    return false;
  }
};
const assistantsPage = async (
  ctx: PageContext,
  user: SessionUser,
  consents: z.infer<typeof consentList>,
  notice: Child = null,
  status = 200,
) => {
  const { config, csrfField } = ctx;
  const disconnected = await listAssistantDisconnects(config, {
    provider: "neon",
    subject: user.id,
  });
  const [names, empty] = await Promise.all([
    Promise.all(
      consents.map((consent, index) =>
        index < NAMED_ASSISTANTS
          ? clientName(ctx, consent.clientId)
          : undefined,
      ),
    ),
    accountEmpty(ctx, user),
  ]);
  return page(
    "Connected assistants",
    <>
      {notice}
      {connectSteps(empty, config.resource)}
      <section aria-labelledby="connected-h">
        <h2 id="connected-h">Connected</h2>
        <p>
          These assistants can read and change your memos. Disconnecting one
          makes Milton refuse it immediately, including sign-in tokens it
          already holds. To use it again, reconnect it from the assistant and
          approve it.
        </p>
        {consents.length === 0 ? (
          <p>No assistants are connected.</p>
        ) : (
          <ul class="assistant-list">
            {consents.map((consent, index) => {
              const incomplete = disconnected.has(consent.clientId);
              const host = clientHost(consent.clientId);
              return (
                <li>
                  <p>
                    <strong>{names[index] || consent.clientId}</strong>
                    {host ? `, from ${host}` : " (name not verified)"}
                  </p>
                  <p class="small-note">
                    Connected {consent.createdAt.toISOString().slice(0, 10)}
                    {incomplete && " · Disconnect incomplete"}
                  </p>
                  <form method="post" action="/assistants/disconnect">
                    {csrfField()}
                    <input type="hidden" name="consent" value={consent.id} />
                    <button class="secondary">
                      {incomplete ? "Retry" : "Disconnect"}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>,
    status,
    null,
    { account: { csrf: csrfField, email: user.email, here: "assistants" } },
  );
};
export const assistants = async (ctx: PageContext): Promise<Response> => {
  const { config, request, url, auth, signedIn, readForm } = ctx;
  if (
    request.method !==
    (url.pathname === "/assistants/disconnect" ? "POST" : "GET")
  )
    return page(
      "Method not allowed",
      <p>Use the page's controls to continue.</p>,
      405,
    );
  if (request.method === "GET") {
    const user = await signedIn();
    return assistantsPage(
      ctx,
      user,
      await readConsents(ctx, user),
      url.searchParams.get("done") === "disconnected" && (
        <p role="status">
          Disconnected. This assistant can no longer read or change your memos,
          and Milton refuses the sign-in tokens it already holds. To use it with
          Milton again, reconnect it from the assistant and approve it.
        </p>
      ),
    );
  }
  const form = await readForm();
  const user = await signedIn();
  const consents = await readConsents(ctx, user);
  // Only an id from this session's live list; never a submitted client id.
  const consent = consents.find((item) => item.id === form.get("consent"));
  if (!consent)
    return page(
      "Assistant not found",
      <>
        <p>This assistant is not connected to your account.</p>
        <p>
          <a href="/assistants">Connected assistants</a>
        </p>
      </>,
      404,
    );
  // Milton's refusal is the immediate cut-off, so it is written first.
  await recordAssistantDisconnect(config, {
    provider: "neon",
    subject: user.id,
    clientId: consent.clientId,
  });
  let removed = false;
  try {
    removed = !(await timed(auth.oauth2.deleteConsent({ id: consent.id })))
      .error;
  } catch {
    /* Reported below; the refusal already stands. */
  }
  if (!removed)
    return assistantsPage(
      ctx,
      user,
      consents,
      <p role="alert">
        Disconnected. Milton now refuses this assistant, but removing it from
        your sign-in provider did not finish. Retry.
      </p>,
      503,
    );
  return Response.redirect(
    config.appOrigin + "/assistants?done=disconnected",
    303,
  );
};
