/** @jsxImportSource hono/jsx */
import type { RuntimeConfig } from "./config";
import { isLoopback } from "./config";
import { StoreError } from "./store";
import { isMemoRoute } from "./memo-pages";
import { AuthError } from "./token";
import { page } from "./pages";
import { pageContext } from "./auth-session";
import { assistants } from "./auth-assistants";
import { accountDeletion } from "./auth-account";
import { signInRoutes } from "./auth-login";
import { logUnexpected } from "./error-log";

export function browserPages(config: RuntimeConfig) {
  const secure = !isLoopback(new URL(config.appOrigin).hostname);
  const csrfName = secure ? "__Host-milton-csrf" : "milton-csrf";
  const loopName = secure ? "__Host-milton-continue" : "milton-continue";
  return async (request: Request): Promise<Response> => {
    const ctx = pageContext(config, request, secure, csrfName, loopName);
    const { url, cookies, renderMemos } = ctx;
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
      return signInRoutes(ctx);
    };
    let response: Response;
    try {
      response = await perform();
    } catch (error) {
      const known = error instanceof AuthError || error instanceof StoreError;
      if (!known) logUnexpected("page", error);
      const failure = known
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
          ) : failure.code === "auth_unavailable" && ctx.loginRecovery ? (
            <p>
              <a class="button" href={ctx.loginRecovery}>
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
