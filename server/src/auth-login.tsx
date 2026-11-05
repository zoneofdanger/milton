/** @jsxImportSource hono/jsx */
import { createHmac } from "node:crypto";
import { processAuthMiddleware } from "@neondatabase/auth/server";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import {
  clearAssistantDisconnect,
  lookupIdentityAccount,
  resolveIdentityAccount,
} from "./store";
import { AuthError } from "./token";
import { ensureSubscription } from "./billing";
import { navigation, page } from "./pages";
import {
  cookieValue,
  silentLog,
  timed,
  upstreamError,
  type PageContext,
} from "./auth-session";
import { clientHost } from "./auth-assistants";

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

const retryLogin = (query: string) =>
  query ? "/login?flow=" + encodeURIComponent(query) : "/login";

/** Sign-in, consent and sign-out: the landing page, /login, /consent and
 * /logout, after the router has checked the path and method. */
export const signInRoutes = async (ctx: PageContext): Promise<Response> => {
  const {
    config,
    request,
    url,
    cookies,
    writeCookie,
    csrfField,
    rotateCsrf,
    auth,
    session,
    signedIn,
    readForm,
    renderMemos,
    csrfName,
    loopName,
  } = ctx;
  // No new approval lands until the account has a subscription. Every Milton step
  // that can lead to one comes through here: /login with a session, and the consent
  // page and form, which a live session reaches without /login. A failure stops the
  // step with a 503 and a way back to sign-in, which is the retry. An approval Neon
  // already holds skips these pages and refreshes without Milton, so existing
  // accounts depend on the backfill.
  const requireSubscription = async (
    userId: string,
    email: string | undefined,
    query: string,
  ) => {
    try {
      await ensureSubscription(config, userId, email);
    } catch (error) {
      ctx.loginRecovery = retryLogin(query);
      throw error;
    }
  };
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
          "Make your agents write like you.",
          <>
            <p>
              Keep writing examples you approve, ready for connected assistants
              to use in your next email or message.
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
      ctx.loginRecovery = retryLogin(query);
      const user = await session();
      if (user) {
        const { miltonUserId } = await resolveIdentityAccount(config, {
          provider: "neon",
          subject: user.id,
        });
        await requireSubscription(miltonUserId, user.email, query);
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
              Your assistant asked for another sign-in. Restart the connection
              from your assistant.
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
          <p class="sign-in-context">
            New to Milton? Try it free for 30 days. No credit card required.
            Then $5.01 USD/month if you add a card.
          </p>
          <p class="small-note">
            <a href="https://www.meetmilton.com/pricing">Pricing</a>
            {" · "}
            <a href="https://www.meetmilton.com/privacy">Privacy</a>
            {" · "}
            <a href="https://www.meetmilton.com/terms">Terms</a>
          </p>
        </>,
      );
    }
    const user = await signedIn();
    const { userId } = await lookupIdentityAccount(config, {
      provider: "neon",
      subject: user.id,
    });
    await requireSubscription(userId, user.email, query);
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
          <strong>{client.data.client_name || params.get("client_id")!}</strong>
          {host ? `, from ${host}` : " (name not verified)"}
        </p>
        {!host && <p>Only allow this if you just started connecting it.</p>}
        <p>
          This assistant will be able to read your cover sheet and reports and
          save rules and samples to them.
        </p>
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
    ctx.loginRecovery = retryLogin(query);
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
  const user = await signedIn();
  const who = { provider: "neon", subject: user.id };
  const { userId } = await lookupIdentityAccount(config, who);
  const decision = form.get("decision");
  if (decision !== "allow" && decision !== "deny")
    throw new AuthError("authorization_invalid", "Choose Allow or Deny.", 400);
  if (decision === "allow")
    await requireSubscription(userId, user.email, query);
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
