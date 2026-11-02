/** @jsxImportSource hono/jsx */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createAuthServer,
  extractNeonAuthCookies,
  NEON_AUTH_SESSION_DATA_COOKIE_NAME,
  processAuthMiddleware,
  resolveNeonAuthLogging,
  serializeSetCookie,
} from "@neondatabase/auth/server";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import { isLoopback } from "./config";
import {
  clearAssistantDisconnect,
  deleteAccount,
  listAssistantDisconnects,
  lookupIdentityAccount,
  recordAssistantDisconnect,
  resolveIdentityAccount,
  StoreError,
  personStoreForCurrentRequest,
  type VerifiedStoreAuth,
} from "./store";
import { accountChrome, memoPages, isMemoRoute } from "./memo-pages";
import type { Child } from "hono/jsx";
import { AuthError } from "./token";
import { navigation, page } from "./pages";

const sessionSchema = z.object({
  user: z.object({
    id: z.string().min(1).max(512),
    // Shown only in authenticated page chrome; an unusable value shows nothing.
    email: z.string().min(1).max(254).optional().catch(undefined),
  }),
  session: z.object({ userId: z.string(), expiresAt: z.coerce.date() }),
});
type SessionUser = z.infer<typeof sessionSchema>["user"];
const consentList = z.array(
  z.object({
    id: z.string().min(1).max(512),
    clientId: z.string().min(1).max(2048),
    userId: z.string(),
    createdAt: z.coerce.date(),
  }),
);
// Name lookups per page view; later rows show the client id unverified.
const NAMED_ASSISTANTS = 20;
const clientHost = (clientId: string) => {
  try {
    const id = new URL(clientId);
    if (id.protocol === "https:") return id.host;
  } catch {
    /* DCR ids are not URLs. */
  }
  return "";
};
const silentLog = resolveNeonAuthLogging({ logLevel: "silent" });
const cookieValue = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + "="))
    ?.slice(name.length + 1);
const equal = (left: string, right: string) =>
  left.length === right.length &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));
async function timed<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AuthError(
                "auth_unavailable",
                "Sign-in is unavailable. Try again.",
                503,
              ),
            ),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function upstreamError(error: { status?: number } | null) {
  if (error)
    throw new AuthError(
      error.status && error.status >= 500
        ? "auth_unavailable"
        : "authorization_invalid",
      error.status && error.status >= 500
        ? "Sign-in is unavailable. Try again."
        : "This sign-in request is invalid or expired. Restart from your assistant.",
      error.status && error.status >= 500 ? 503 : 400,
    );
}
function oauthQuery(
  request: Request,
  config: RuntimeConfig,
  submitted?: string,
) {
  const url = new URL(request.url);
  // The wrapper survives the SDK callback's URLSearchParams reserialization.
  const query =
    submitted ?? url.searchParams.get("flow") ?? url.search.slice(1);
  if (query.length > 8192)
    throw new AuthError(
      "authorization_invalid",
      "Restart the connection from your assistant.",
      400,
    );
  if (!query && url.pathname === "/login") return "";
  const parsed = new URLSearchParams(query);
  if (
    // Neon's signed query repeats ba_param; only the fields Milton reads must be single.
    ["resource", "client_id", "redirect_uri", "sig"].some(
      (key) => parsed.getAll(key).length !== 1,
    ) ||
    parsed.get("resource") !== config.resource ||
    !parsed.get("client_id") ||
    !parsed.get("sig") ||
    !parsed.get("redirect_uri")
  )
    throw new AuthError(
      "authorization_invalid",
      "This connection request is incomplete. Restart from your assistant.",
      400,
    );
  try {
    const callback = new URL(parsed.get("redirect_uri")!);
    if (callback.username || callback.password) throw new Error();
  } catch {
    throw new AuthError(
      "authorization_invalid",
      "This return address is invalid. Restart from your assistant.",
      400,
    );
  }
  return query;
}

export function browserPages(config: RuntimeConfig) {
  const secure = !isLoopback(new URL(config.appOrigin).hostname);
  const csrfName = secure ? "__Host-milton-csrf" : "milton-csrf";
  const loopName = secure ? "__Host-milton-continue" : "milton-continue";
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let loginRecovery: string | undefined;
    const cookies: string[] = [];
    const writeCookie = (name: string, value: string, maxAge = 3600) =>
      cookies.push(
        serializeSetCookie({
          name,
          value,
          path: "/",
          httpOnly: true,
          secure,
          sameSite: "lax",
          maxAge,
        }),
      );
    let csrf = cookieValue(request, csrfName);
    const csrfField = () => {
      if (!csrf || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) {
        csrf = randomBytes(32).toString("base64url");
        writeCookie(csrfName, csrf);
      }
      return <input type="hidden" name="csrf" value={csrf} />;
    };
    const rotateCsrf = () => {
      csrf = randomBytes(32).toString("base64url");
      writeCookie(csrfName, csrf);
    };
    const auth = createAuthServer({
      baseUrl: config.issuer,
      cookieSecret: config.cookieSecret,
      sameSite: "lax",
      log: silentLog,
      context: () => ({
        // Admission and mutations always ask Neon for a live session, rather
        // than accepting the SDK's cached session-data cookie as revocation proof.
        getCookies: () =>
          extractNeonAuthCookies(
            (request.headers.get("Cookie") ?? "")
              .split(";")
              .filter(
                (value) =>
                  !value
                    .trim()
                    .startsWith(NEON_AUTH_SESSION_DATA_COOKIE_NAME + "="),
              )
              .join(";"),
          ),
        setCookie: (name, value, options) => {
          cookies.push(serializeSetCookie({ name, value, ...options }));
        },
        getHeader: (name) => request.headers.get(name),
        getOrigin: () => config.appOrigin,
        getFramework: () => "milton-node",
      }),
    });
    const session = async () => {
      const result = await timed(auth.getSession());
      if (result.error?.status === 401) return null;
      upstreamError(result.error);
      if (!result.data?.session || !result.data.user) return null;
      const parsed = sessionSchema.safeParse(result.data);
      if (
        !parsed.success ||
        parsed.data.user.id !== parsed.data.session.userId ||
        parsed.data.session.expiresAt.getTime() <= Date.now()
      )
        return null;
      return parsed.data.user;
    };
    const signedIn = async () => {
      const user = await session();
      if (!user)
        throw new AuthError(
          "session_required",
          "Sign in to Milton before continuing.",
          403,
        );
      return user;
    };
    const identity = async () => ({
      provider: "neon",
      subject: (await signedIn()).id,
    });
    const readForm = async () => {
      const origin = request.headers.get("Origin");
      const sameOrigin =
        origin === config.appOrigin ||
        ((!origin || origin === "null") &&
          request.headers.get("Sec-Fetch-Site") === "same-origin" &&
          url.origin === config.appOrigin);
      const contentType = request.headers.get("Content-Type") ?? "";
      if (
        !sameOrigin ||
        !contentType.startsWith("application/x-www-form-urlencoded")
      )
        throw new AuthError(
          "csrf_refused",
          "Reload the page before submitting this form.",
          403,
        );
      let form: URLSearchParams;
      try {
        form = new URLSearchParams(await request.text());
      } catch {
        throw new AuthError(
          "csrf_refused",
          "Reload the page before submitting this form.",
          403,
        );
      }
      const submitted = form.get("csrf");
      if (
        !csrf ||
        !submitted ||
        !/^[A-Za-z0-9_-]{43}$/.test(csrf) ||
        !/^[A-Za-z0-9_-]{43}$/.test(submitted) ||
        !equal(csrf, submitted) ||
        [...new Set(form.keys())].some((key) => form.getAll(key).length !== 1)
      )
        throw new AuthError(
          "csrf_refused",
          "Reload the page before submitting this form.",
          403,
        );
      return form;
    };
    const renderMemos = async (signedInUser?: SessionUser) => {
      const user = signedInUser ?? (await signedIn());
      const verified: VerifiedStoreAuth = await lookupIdentityAccount(config, {
        provider: "neon",
        subject: user.id,
      });
      const store = await personStoreForCurrentRequest(config, verified);
      return memoPages(request, store, csrfField, user.email);
    };
    const assistantsUnavailable = () =>
      new AuthError(
        "assistants_unavailable",
        "Connected assistants are unavailable right now. Try again.",
        503,
      );
    // Always the live list from Neon for this session; never a cached copy.
    const readConsents = async (user: SessionUser) => {
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
    const clientName = async (clientId: string) => {
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
    const assistantsPage = async (
      user: SessionUser,
      consents: z.infer<typeof consentList>,
      notice: Child = null,
      status = 200,
    ) => {
      const disconnected = await listAssistantDisconnects(config, {
        provider: "neon",
        subject: user.id,
      });
      const names = await Promise.all(
        consents.map((consent, index) =>
          index < NAMED_ASSISTANTS ? clientName(consent.clientId) : undefined,
        ),
      );
      return page(
        "Connected assistants",
        <>
          {accountChrome(csrfField, user.email, "assistants")}
          {notice}
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
        </>,
        status,
      );
    };
    const assistants = async (): Promise<Response> => {
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
          user,
          await readConsents(user),
          url.searchParams.get("done") === "disconnected" && (
            <p role="status">
              Disconnected. This assistant can no longer read or change your
              memos, and Milton refuses the sign-in tokens it already holds. To
              use it with Milton again, reconnect it from the assistant and
              approve it.
            </p>
          ),
        );
      }
      const form = await readForm();
      const user = await signedIn();
      const consents = await readConsents(user);
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
          user,
          consents,
          <p role="alert">
            Disconnected. Milton now refuses this assistant, but removing it
            from your sign-in provider did not finish. Retry.
          </p>,
          503,
        );
      return Response.redirect(
        config.appOrigin + "/assistants?done=disconnected",
        303,
      );
    };
    // Account deletion. The phrase must match exactly; nothing is deleted
    // until Milton has recorded a disconnect for every live consent.
    const deletePhrase = "delete my account";
    const activeAccount = async (user: SessionUser) => {
      try {
        await lookupIdentityAccount(config, {
          provider: "neon",
          subject: user.id,
        });
      } catch (error) {
        if (error instanceof StoreError && error.code === "account_unavailable")
          throw new StoreError(
            "account_unavailable",
            "This Milton account is unavailable. It may already be deleted.",
            403,
          );
        throw error;
      }
    };
    const deletionPage = (
      user: SessionUser,
      notice: Child = null,
      status = 200,
    ) =>
      page(
        "Delete your account",
        <>
          {accountChrome(csrfField, user.email, "delete")}
          {notice}
          <p>
            Deleting your Milton account cannot be undone. To keep a copy of
            your report, <a href="/download">download TPS.md</a> first.
          </p>
          <h2>Deleted now</h2>
          <p>
            Your rules, approved samples, report and its history, save receipts,
            usage counters, and Milton's link to your sign-in. Every connected
            assistant is disconnected and you are signed out.
          </p>
          <h2>Kept</h2>
          <ul>
            <li>Daily spending totals that are not linked to your account.</li>
            <li>
              A record of the assistants you connected (sign-in ID and assistant
              ID, no content), so their old tokens cannot reach a new account.
            </li>
            <li>
              A one-way fingerprint of your sign-in, so a new account does not
              get a second trial.
            </li>
            <li>
              If you received an early-access invitation, that invitation entry
              (your sign-in ID), which an operator can remove.
            </li>
            <li>
              Your sign-in record (email, name, Google or GitHub link) stays
              with our sign-in provider. To remove it, email{" "}
              <a href="mailto:support@meetmilton.com">support@meetmilton.com</a>
              .
            </li>
            <li>
              Copies in database backups are not erased immediately; they are
              removed when those backups expire or are deleted.
            </li>
          </ul>
          <form method="post" action="/account/delete">
            {csrfField()}
            <label>
              <span>
                Type <code>{deletePhrase}</code> to confirm.
              </span>
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
        status,
      );
    const accountDeletion = async (): Promise<Response> => {
      if (request.method !== "GET" && request.method !== "POST")
        return page(
          "Method not allowed",
          <p>Use the page's controls to continue.</p>,
          405,
        );
      if (request.method === "GET") {
        const user = await signedIn();
        await activeAccount(user);
        return deletionPage(user);
      }
      const form = await readForm();
      const user = await signedIn();
      await activeAccount(user);
      if (form.get("confirm") !== deletePhrase)
        return deletionPage(
          user,
          <p role="alert">
            Type {deletePhrase} exactly to delete your account. Nothing was
            deleted.
          </p>,
          400,
        );
      let consents: z.infer<typeof consentList>;
      try {
        consents = await readConsents(user);
      } catch (error) {
        if (error instanceof AuthError && error.code === "session_required")
          throw error;
        throw new AuthError(
          "deletion_unavailable",
          "Account deletion is unavailable right now. Nothing was deleted. Try again.",
          503,
        );
      }
      await deleteAccount(
        config,
        { provider: "neon", subject: user.id },
        consents.map((consent) => consent.clientId),
      );
      // Best effort from here: Milton already refuses every listed assistant.
      await Promise.allSettled(
        consents.map((consent) =>
          timed(auth.oauth2.deleteConsent({ id: consent.id })),
        ),
      );
      let signedOut = false;
      try {
        signedOut = !(await timed(auth.signOut())).error;
      } catch {
        /* The account is gone either way. */
      }
      writeCookie(csrfName, "", 0);
      writeCookie(loopName, "", 0);
      return page(
        "Account deleted",
        <>
          <p role="status">Your Milton account is deleted.</p>
          <p>
            Your rules, approved samples, report and its history, save receipts
            and usage counters are gone, and Milton no longer links to your
            sign-in. Every connected assistant is disconnected.
            {signedOut
              ? " This browser is signed out."
              : " Signing this browser out did not finish; sign out of your Google or GitHub account if this is a shared computer."}
          </p>
          <p>
            Copies in database backups are not erased immediately; they are
            removed when those backups expire or are deleted. Your sign-in
            record stays with our sign-in provider. To remove it, email{" "}
            <a href="mailto:support@meetmilton.com">support@meetmilton.com</a>.
          </p>
          <p>
            <a href="/">Milton home</a>
          </p>
        </>,
      );
    };
    const perform = async (): Promise<Response> => {
      if (isMemoRoute(url.pathname) && url.pathname !== "/")
        return renderMemos();
      if (
        url.pathname === "/assistants" ||
        url.pathname === "/assistants/disconnect"
      )
        return assistants();
      if (url.pathname === "/account/delete") return accountDeletion();
      if (!["/", "/login", "/consent", "/logout"].includes(url.pathname))
        return page("Not found", <p>This page does not exist.</p>, 404);
      if (
        !["GET", "POST"].includes(request.method) ||
        (url.pathname === "/logout" && request.method !== "POST") ||
        (url.pathname === "/" && request.method !== "GET")
      )
        return page(
          "Method not allowed",
          <p>Use the page's controls to continue.</p>,
          405,
        );
      if (request.method === "GET") {
        // The toolkit skips callback exchange on its configured login pathname.
        // Our public landing page is its fallback; /login stays in skipRoutes
        // so verifier callbacks there still run before the public-route check.
        const middleware = await timed(
          processAuthMiddleware({
            request,
            pathname: url.pathname,
            skipRoutes: ["/", "/login"],
            loginUrl: config.appOrigin + "/",
            baseUrl: config.issuer,
            cookieSecret: config.cookieSecret,
            sameSite: "lax",
            log: silentLog,
          }),
        );
        cookies.push(...(middleware.cookies ?? []));
        if (middleware.action === "redirect_oauth") {
          if (middleware.redirectUrl.origin !== config.appOrigin)
            throw new AuthError(
              "authorization_invalid",
              "Restart the connection from your assistant.",
              400,
            );
          return Response.redirect(middleware.redirectUrl, 302);
        }
        if (middleware.action === "redirect_login")
          return Response.redirect(
            config.appOrigin +
              "/login?flow=" +
              encodeURIComponent(oauthQuery(request, config)),
            302,
          );
        for (const [name, value] of Object.entries(middleware.headers ?? {}))
          request.headers.set(name, value);
        if (url.pathname === "/") {
          const user = await session();
          if (!user)
            return page(
              "Your instructions, in every assistant.",
              <>
                <p>
                  Keep how you like things done in one place, ready for the
                  assistants you connect.
                </p>
                <p>
                  <a class="button" href="/login">
                    Sign in to Milton
                  </a>
                </p>
              </>,
            );
          return renderMemos(user);
        }
        const query = oauthQuery(request, config);
        const hidden = <input type="hidden" name="oauth_query" value={query} />;
        if (url.pathname === "/login") {
          loginRecovery = query
            ? "/login?flow=" + encodeURIComponent(query)
            : "/login";
          const user = await session();
          if (user) {
            await resolveIdentityAccount(config, {
              provider: "neon",
              subject: user.id,
            });
            rotateCsrf();
            if (!query) return Response.redirect(config.appOrigin + "/", 302);
            const params = new URLSearchParams(query);
            const marker = createHmac("sha256", config.cookieSecret)
              .update(query)
              .digest("base64url");
            if (
              (params.get("prompt")?.split(" ").includes("login") ||
                params.get("max_age") === "0") &&
              cookieValue(request, loopName) === marker
            )
              return page(
                "Sign-in requested again",
                <p>
                  Your assistant asked for another sign-in. Restart the
                  connection from your assistant.
                </p>,
                400,
              );
            writeCookie(loopName, marker, 600);
            const result = await timed(
              auth.oauth2.continue({ selected: true, oauth_query: query }),
            );
            upstreamError(result.error);
            if (!result.data?.url)
              throw new AuthError(
                "auth_unavailable",
                "Sign-in is unavailable. Try again.",
                503,
              );
            return navigation(result.data.url);
          }
          return page(
            "Sign in to Milton",
            <>
              <p>Choose an account to continue.</p>
              <form method="post" action="/login">
                {csrfField()}
                {hidden}
                <button name="provider" value="google">
                  Continue with Google
                </button>
                <button class="secondary" name="provider" value="github">
                  Continue with GitHub
                </button>
              </form>
            </>,
          );
        }
        await lookupIdentityAccount(config, await identity());
        const params = new URLSearchParams(query);
        const result = await timed(
          auth.oauth2.publicClient({
            query: { client_id: params.get("client_id")! },
          }),
        );
        upstreamError(result.error);
        const client = z
          .object({
            client_name: z.string().optional(),
            client_uri: z.string().optional(),
          })
          .safeParse(result.data);
        if (!client.success)
          throw new AuthError(
            "authorization_invalid",
            "Restart the connection from your assistant.",
            400,
          );
        const redirect = new URL(params.get("redirect_uri")!);
        const destination = redirect.host || redirect.protocol;
        const host = clientHost(params.get("client_id")!);
        return page(
          "Connect an assistant",
          <>
            <p>
              <strong>
                {client.data.client_name || params.get("client_id")!}
              </strong>
              {host ? `, from ${host}` : " (name not verified)"}
            </p>
            {!host && <p>Only allow this if you just started connecting it.</p>}
            <p>This assistant will be able to read and change your memos.</p>
            <p>Return destination: {destination}</p>
            <form method="post" action="/consent">
              {csrfField()}
              {hidden}
              <button name="decision" value="allow">
                Allow
              </button>
              <button class="secondary" name="decision" value="deny">
                Deny
              </button>
            </form>
          </>,
        );
      }
      const form = await readForm();
      if (url.pathname === "/logout") {
        const result = await timed(auth.signOut());
        upstreamError(result.error);
        writeCookie(csrfName, "", 0);
        writeCookie(loopName, "", 0);
        // "Switch account" lands on sign-in; any other value goes home.
        return navigation(
          config.appOrigin + (form.get("next") === "login" ? "/login" : "/"),
        );
      }
      const query = oauthQuery(request, config, form.get("oauth_query") ?? "");
      if (url.pathname === "/login") {
        loginRecovery = query
          ? "/login?flow=" + encodeURIComponent(query)
          : "/login";
        const provider = form.get("provider");
        if (provider !== "google" && provider !== "github")
          throw new AuthError(
            "authorization_invalid",
            "Choose a supported sign-in provider.",
            400,
          );
        const callbackURL =
          config.appOrigin +
          "/login" +
          (query ? "?flow=" + encodeURIComponent(query) : "");
        const result = await timed(
          auth.signIn.social({
            provider,
            callbackURL,
            ...(query ? { oauth_query: query } : {}),
          }),
        );
        upstreamError(result.error);
        if (!result.data?.url)
          throw new AuthError(
            "auth_unavailable",
            "Sign-in is unavailable. Try again.",
            503,
          );
        rotateCsrf();
        return navigation(result.data.url);
      }
      const who = await identity();
      await lookupIdentityAccount(config, who);
      const decision = form.get("decision");
      if (decision !== "allow" && decision !== "deny")
        throw new AuthError(
          "authorization_invalid",
          "Choose Allow or Deny.",
          400,
        );
      const result = await timed(
        auth.oauth2.consent({
          accept: decision === "allow",
          oauth_query: query,
        }),
      );
      upstreamError(result.error);
      if (!result.data?.url)
        throw new AuthError(
          "auth_unavailable",
          "Sign-in is unavailable. Try again.",
          503,
        );
      // Approving again reconnects a disconnected assistant. Never send the
      // approval while Milton still refuses it. The provider has already kept
      // the approval and will skip this page next time, so the way out is to
      // remove it from Connected assistants and reconnect.
      if (decision === "allow") {
        const clear = () =>
          clearAssistantDisconnect(config, {
            ...who,
            clientId: new URLSearchParams(query).get("client_id")!,
          });
        await clear()
          .catch(clear)
          .catch(() => {
            throw new AuthError(
              "reconnect_incomplete",
              "Milton could not finish reconnecting this assistant. Open Connected assistants, choose Retry or Disconnect for this assistant, then reconnect it from the assistant.",
              503,
            );
          });
      }
      return navigation(result.data.url);
    };
    let response: Response;
    try {
      response = await perform();
    } catch (error) {
      const failure =
        error instanceof AuthError || error instanceof StoreError
          ? error
          : new AuthError(
              "auth_unavailable",
              "Sign-in is unavailable. Try again.",
              503,
            );
      response = page(
        "Unable to continue",
        <>
          <p>{failure.message}</p>
          {failure.code === "session_required" ? (
            <p>
              <a class="button" href="/login">
                Sign in to Milton
              </a>
            </p>
          ) : failure.code === "auth_unavailable" && loginRecovery ? (
            <p>
              <a class="button" href={loginRecovery}>
                Back to sign-in
              </a>
            </p>
          ) : url.pathname.startsWith("/assistants") ||
            failure.code === "reconnect_incomplete" ? (
            <p>
              <a href="/assistants">Connected assistants</a>
            </p>
          ) : url.pathname === "/account/delete" &&
            failure.code !== "account_unavailable" ? (
            <p>
              <a href="/account/delete">Back to account deletion</a>
            </p>
          ) : (
            isMemoRoute(url.pathname) && (
              <p>
                <a href="/tps-report">View current report</a>
              </p>
            )
          )}
        </>,
        failure.status,
      );
    }
    const headers = new Headers(response.headers);
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, { status: response.status, headers });
  };
}
