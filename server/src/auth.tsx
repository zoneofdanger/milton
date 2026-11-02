/** @jsxImportSource hono/jsx */
import { createHmac } from "node:crypto";
import { processAuthMiddleware } from "@neondatabase/auth/server";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import { isLoopback } from "./config";
import {
  clearAssistantDisconnect,
  lookupIdentityAccount,
  resolveIdentityAccount,
  StoreError,
} from "./store";
import { isMemoRoute } from "./memo-pages";
import { AuthError } from "./token";
import { navigation, page } from "./pages";
import {
  cookieValue,
  pageContext,
  silentLog,
  timed,
  upstreamError,
} from "./auth-session";
import { assistants, clientHost } from "./auth-assistants";
import { accountDeletion } from "./auth-account";

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
    const ctx = pageContext(config, request, secure, csrfName, loopName);
    const {
      url,
      cookies,
      writeCookie,
      csrfField,
      rotateCsrf,
      auth,
      session,
      identity,
      readForm,
      renderMemos,
    } = ctx;
    let loginRecovery: string | undefined;
    const perform = async (): Promise<Response> => {
      if (isMemoRoute(url.pathname) && url.pathname !== "/")
        return renderMemos();
      if (
        url.pathname === "/assistants" ||
        url.pathname === "/assistants/disconnect"
      )
        return assistants(ctx);
      if (url.pathname === "/account/delete") return accountDeletion(ctx);
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
