/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { page } from "./pages";
import type { PageContext, SessionUser } from "./auth-session";
import {
  connectionKeysForAccount,
  EXPIRED_KEY_HISTORY,
  keyExpiries,
  MAX_ACTIVE_KEYS,
  StoreError,
  type ConnectionKey,
  type KeyExpiry,
  type KeyScope,
} from "./store";

export const isKeyRoute = (path: string) =>
  path === "/assistants/keys" || path === "/assistants/keys/revoke";

const day = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const when = (date: Date) => (
  <time datetime={date.toISOString()}>{day.format(date)}</time>
);
const access = (scope: KeyScope) =>
  scope === "read_write" ? "Read and save" : "Read only";
const expiry = (key: ConnectionKey) =>
  key.expiresAt === null ? (
    <strong>Never expires</strong>
  ) : key.expired ? (
    <>Expired {when(key.expiresAt)}</>
  ) : (
    <>Expires {when(key.expiresAt)}</>
  );

/** The signed-in person's keys, by their Milton account, bound to the
 * session's validated native identity, incarnation and generation. */
export const accountKeys = async (ctx: PageContext, user: SessionUser) =>
  connectionKeysForAccount(ctx.config, await ctx.account(user), {
    issuer: ctx.config.issuer,
    subject: user.id,
    incarnation: user.incarnation,
    generation: user.generation,
  });

const keyItems = (keys: ConnectionKey[]) => (
  <ul class="assistant-list">
    {keys.map((key) => (
      <li>
        <p>
          <strong>{key.name}</strong>
        </p>
        <p class="small-note">
          {access(key.scope)} · Created {when(key.createdAt)} ·{" "}
          {key.lastUsedAt ? (
            <>Last used {when(key.lastUsedAt)}</>
          ) : (
            "Never used"
          )}{" "}
          · {expiry(key)}
        </p>
        {key.stopped && (
          <p>
            <strong>Stopped working.</strong> Your sign-in security changed
            after this key was created, for example by a password reset.
            Creating a key revokes it.
          </p>
        )}
        <p>
          <a
            class="button secondary"
            href={`/assistants/keys/revoke?key=${key.id}`}
          >
            Revoke
          </a>
        </p>
      </li>
    ))}
  </ul>
);

/** The Connected assistants page's section: every active key, the most
 * recently expired ones, and the create form. */
export function keysSection(
  keys: { active: ConnectionKey[]; expired: ConnectionKey[] },
  csrfField: () => Child,
) {
  const live = keys.active.filter((key) => !key.stopped).length;
  return (
    <section aria-labelledby="connection-keys-h" id="connection-keys">
      <h2 id="connection-keys-h">Connection keys</h2>
      <p>
        For agents that run without a browser, such as scheduled tasks, cloud
        agents and CI jobs. The agent sends the key with every request. Treat a
        key like a password: choose read only unless the agent needs to save,
        and revoke keys you no longer use.
      </p>
      {keys.active.length === 0 ? (
        <p>
          {keys.expired.length === 0
            ? "No connection keys."
            : "No active connection keys."}
        </p>
      ) : (
        keyItems(keys.active)
      )}
      {keys.expired.length > 0 && (
        <>
          <h3>Expired keys</h3>
          <p class="small-note">
            Expired keys no longer work. The {EXPIRED_KEY_HISTORY} most recently
            expired are shown.
          </p>
          {keyItems(keys.expired)}
        </>
      )}
      {live >= MAX_ACTIVE_KEYS ? (
        <p>
          You have {MAX_ACTIVE_KEYS} active keys, the most an account can have.
          Revoke one to create another.
        </p>
      ) : (
        <form method="post" action="/assistants/keys" class="key-form">
          {csrfField()}
          <h3>Create a key</h3>
          <label>
            Name
            <input
              name="name"
              required
              maxlength={60}
              autocomplete="off"
              placeholder="Nightly summary job"
            />
          </label>
          <fieldset>
            <legend>Access</legend>
            <label class="choice">
              <input type="radio" name="scope" value="read" checked />
              Read only
            </label>
            <label class="choice">
              <input type="radio" name="scope" value="read_write" />
              Read and save
            </label>
          </fieldset>
          <fieldset>
            <legend>Expires</legend>
            {keyExpiries.map((days) => (
              <label class="choice">
                <input
                  type="radio"
                  name="expiry"
                  value={days === null ? "never" : String(days)}
                  checked={days === 90}
                />
                {days === null ? "Never" : `In ${days} days`}
              </label>
            ))}
          </fieldset>
          <button>Create key</button>
        </form>
      )}
    </section>
  );
}

const backLink = (
  <p>
    <a href="/assistants#connection-keys">Back to Connected assistants</a>
  </p>
);
const methodNotAllowed = () =>
  page("Method not allowed", <p>Use the page's controls to continue.</p>, 405);

/** POST /assistants/keys creates a key and shows it once. GET and POST
 * /assistants/keys/revoke confirm, then revoke, one key. */
export const connectionKeyRoutes = async (
  ctx: PageContext,
): Promise<Response> => {
  const { config, request, url, csrfField, readForm, signedIn } = ctx;
  const chrome = async (user: SessionUser) => ({
    account: {
      csrf: csrfField,
      email: user.email,
      billing: await ctx.accountBilling(user),
    },
  });
  if (url.pathname === "/assistants/keys") {
    if (request.method === "GET")
      return Response.redirect(
        config.appOrigin + "/assistants#connection-keys",
        303,
      );
    if (request.method !== "POST") return methodNotAllowed();
    const form = await readForm();
    const user = await signedIn();
    // A key outlives the browser session, so creating one needs a recent sign-in.
    await ctx.fresh(user);
    const scope = form.get("scope");
    const days = form.get("expiry");
    const chosen = keyExpiries.find(
      (value) => (value === null ? "never" : String(value)) === days,
    );
    if ((scope !== "read" && scope !== "read_write") || chosen === undefined)
      throw new StoreError(
        "invalid_input",
        "Name the key in 1 to 60 characters on one line, and choose its access and expiry.",
        400,
      );
    const keys = await accountKeys(ctx, user);
    const { key, record } = await keys.create({
      name: form.get("name") ?? "",
      scope,
      expiry: chosen as KeyExpiry,
    });
    const command = `claude mcp add --transport http milton ${config.resource} --header "Authorization: Bearer ${key}"`;
    return page(
      "Connection key created",
      <>
        <p role="status">
          Copy this key now. You won’t see it again: Milton keeps only a
          fingerprint of it.
        </p>
        <pre class="setup-copy">
          <code>{key}</code>
        </pre>
        <p>
          <strong>{record.name}</strong> · {access(record.scope)} ·{" "}
          {expiry(record)}
        </p>
        <section aria-labelledby="use-key">
          <h2 id="use-key">Use it</h2>
          <p>In Claude Code, run:</p>
          <pre class="setup-copy">
            <code>{command}</code>
          </pre>
          <p>
            Other agents send it as the header{" "}
            <code>Authorization: Bearer &lt;key&gt;</code> to{" "}
            <code>{config.resource}</code>.{" "}
            <a href="https://www.meetmilton.com/for-agents#headless">
              Setup for Codex, Cursor and others
            </a>
            .
          </p>
        </section>
        {backLink}
      </>,
      200,
      null,
      await chrome(user),
    );
  }
  if (request.method === "GET") {
    const user = await signedIn();
    // By id and owning account, never through the bounded list.
    const target = await (
      await accountKeys(ctx, user)
    ).find(url.searchParams.get("key") ?? "");
    if (!target)
      return page(
        "Key not found",
        <>
          <p>This key is already revoked or does not exist.</p>
          {backLink}
        </>,
        404,
        null,
        await chrome(user),
      );
    return page(
      "Revoke this key?",
      <>
        <p>
          <strong>{target.name}</strong> · {access(target.scope)} · Created{" "}
          {when(target.createdAt)}
        </p>
        <p>
          Agents using this key are refused from their next request. This cannot
          be undone; create a new key to connect again.
        </p>
        <form method="post" action="/assistants/keys/revoke">
          {csrfField()}
          <input type="hidden" name="key" value={target.id} />
          <div class="action-row">
            <button>Revoke key</button>
            <a class="button secondary" href="/assistants#connection-keys">
              Cancel
            </a>
          </div>
        </form>
      </>,
      200,
      null,
      await chrome(user),
    );
  }
  if (request.method !== "POST") return methodNotAllowed();
  const form = await readForm();
  const user = await signedIn();
  await (await accountKeys(ctx, user)).revoke(form.get("key") ?? "");
  return Response.redirect(
    config.appOrigin + "/assistants#connection-keys",
    303,
  );
};
