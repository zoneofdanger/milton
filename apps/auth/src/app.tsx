/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { staticAssets } from "@milton/theme/assets";
import type { AuthService } from "./provider.ts";
import { AUTH_ORIGIN } from "./config.ts";
import {
  boundedBody,
  guardRequest,
  json,
  loadBalancerClient,
  SECURITY_HEADERS,
  TURNSTILE_CSP,
  TURNSTILE_SCRIPT,
} from "./http.ts";
import {
  Page as Shell,
  SignIn,
  EmailForm,
  ResetForm,
  Consent,
  Security,
  type MethodSummary,
  type SessionSummary,
} from "./screens.tsx";

export function createApp(
  auth: AuthService,
  assets = new URL("../public/", import.meta.url).pathname,
) {
  const statics = staticAssets(assets);
  const Page = (props: Omit<Parameters<typeof Shell>[0], "assets">) =>
    Shell({ ...props, assets: statics });
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: { staticAsset: boolean; turnstile: boolean };
  }>();
  app.use("*", async (c, next) => {
    const denied = guardRequest(c.req.raw);
    if (denied) c.res = denied;
    else await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS))
      // A served static asset keeps its own Cache-Control (immutable when the
      // URL's version matches, otherwise no-cache); all else stays no-store.
      // Only the page rendering the Turnstile widget widens the CSP.
      if (k === "content-security-policy" && c.get("turnstile"))
        c.header(k, TURNSTILE_CSP);
      else if (k !== "cache-control" || !c.get("staticAsset")) c.header(k, v);
  });
  const peer = (c: Parameters<typeof getConnInfo>[0]) => {
    const client = loadBalancerClient(c.req.header("x-forwarded-for") ?? null);
    if (client) return client;
    try {
      return getConnInfo(c).remote.address ?? "127.0.0.1";
    } catch {
      return "127.0.0.1";
    }
  };
  app.get("/health", (c) => c.json({ service: "milton-auth", status: "ok" }));
  app.get("*", async (c, next) => {
    const asset = statics.respond(c.req.raw);
    if (!asset) return next();
    c.set("staticAsset", true);
    return asset;
  });
  app.use("/fonts/*", serveStatic({ root: assets }));
  const navigate = (c: Context, response: Response, target: string) => {
    const url = new URL(target, AUTH_ORIGIN);
    if (
      url.username ||
      url.password ||
      /[\r\n]/.test(target) ||
      ["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(
        url.protocol,
      ) ||
      (url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("unsafe_native_destination");
    // End the form submission with a new document, even for same-origin
    // authorize URLs whose later hop leaves form-action 'self'.
    return c.html(
      <Page title="Continue" refresh={url.href}>
        <p>Taking you to the next page.</p>
        <p>
          <a href={url.href}>Continue</a>
        </p>
      </Page>,
      200,
      { "set-cookie": response.headers.getSetCookie() },
    );
  };
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const response = await auth.handler(c.req.raw, peer(c));
    const accept = c.req.header("accept") ?? "";
    const mode = c.req.header("sec-fetch-mode");
    const destination = response.headers.get("location");
    // Native validates and executes first. Only an HTML form navigation needs
    // a new document; fetch/JSON, machine POSTs and every GET keep native output.
    if (
      c.req.method === "POST" &&
      c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
        "application/x-www-form-urlencoded" &&
      mode !== "cors" &&
      !accept.includes("application/json") &&
      (mode === "navigate" || accept.includes("text/html")) &&
      response.status >= 300 &&
      response.status < 400 &&
      destination
    )
      return navigate(c, response, destination);
    return response;
  });
  const oauthQuery = (q: URLSearchParams) =>
    q.has("sig") && q.has("client_id") ? q.toString() : "";
  const notice = (value: string | undefined) =>
    value === "done"
      ? "Your request was accepted. Check your email, or sign in again to continue."
      : value === "retry"
        ? "This request could not be completed. Check your details and try again. Expired links require a new request."
        : undefined;
  app.get("/", (c) => c.redirect("/login", 303));
  // The pages a password form's refusal re-renders, with its alert and status.
  type Refusal = { alert?: string; status?: 400 | 429 };
  const signIn = (
    c: Context,
    query: URLSearchParams,
    { alert, status }: Refusal = {},
    email?: string,
  ) =>
    c.html(
      <Page
        title="Sign in"
        notice={alert ? undefined : notice(c.req.query("notice"))}
        alert={alert}
      >
        <SignIn query={oauthQuery(query)} email={email} />
      </Page>,
      status ?? 200,
    );
  const signUp = (
    c: Context,
    query: URLSearchParams,
    { alert, status }: Refusal = {},
    typed: { name?: string; email?: string } = {},
  ) => {
    const siteKey = auth.turnstileSiteKey;
    if (siteKey) c.set("turnstile", true);
    return c.html(
      <Page
        title="Create your account"
        script={siteKey ? TURNSTILE_SCRIPT : undefined}
        alert={alert}
      >
        <SignIn
          signup
          query={oauthQuery(query)}
          turnstile={siteKey}
          {...typed}
        />
      </Page>,
      status ?? 200,
    );
  };
  const resetPassword = (
    c: Context,
    token: string,
    { alert, status }: Refusal = {},
  ) =>
    c.html(
      <Page title="Set a new password" alert={alert}>
        <ResetForm token={token} />
      </Page>,
      status ?? 200,
    );
  app.get("/login", (c) => signIn(c, new URL(c.req.url).searchParams));
  app.get("/signup", (c) => signUp(c, new URL(c.req.url).searchParams));
  app.get("/verify", (c) =>
    c.html(
      <Page title="Verify your email" notice={notice(c.req.query("notice"))}>
        <EmailForm />
      </Page>,
    ),
  );
  app.get("/forgot-password", (c) =>
    c.html(
      <Page title="Set a password" notice={notice(c.req.query("notice"))}>
        <EmailForm reset />
      </Page>,
    ),
  );
  app.get("/reset-password", (c) =>
    resetPassword(c, c.req.query("token") ?? ""),
  );
  app.get("/consent", (c) =>
    c.html(
      <Page title="Connect an AI">
        <Consent query={new URL(c.req.url).searchParams} />
      </Page>,
    ),
  );
  app.get("/admission", (c) =>
    c.html(
      <Page title="Connection needs a retry">
        <p>
          Milton could not finish checking this account. Start the connection
          again from your AI.
        </p>
        <a href="/login">Sign in</a>
      </Page>,
      503,
    ),
  );
  async function current(c: Context) {
    const r = await auth.handler(
      new Request(AUTH_ORIGIN + "/api/auth/get-session", {
        headers: c.req.raw.headers,
      }),
      peer(c),
    );
    if (!r.ok) throw new Error("native_session_unavailable");
    return (await r.json()) as {
      user: { id: string; email: string; emailVerified: boolean };
      session: { id: string; createdAt: string };
    } | null;
  }
  const security = async (c: Context, { alert, status }: Refusal = {}) => {
    const s = await current(c);
    if (!s) return c.redirect("/login", 303);
    const methods = await auth.pool.query<MethodSummary>(
      'select id,"providerId" from milton_auth.account where "userId"=$1 order by id limit 8',
      [s.user.id],
    );
    const sessions = await auth.pool.query<SessionSummary>(
      'select id,"createdAt","expiresAt",id=$2 as current from milton_auth.session where "userId"=$1 and "expiresAt">now() order by "createdAt" desc limit 64',
      [s.user.id, s.session.id],
    );
    return c.html(
      <Page
        title="Account security"
        notice={alert ? undefined : notice(c.req.query("notice"))}
        alert={alert}
      >
        <Security
          email={s.user.email}
          fresh={
            s.user.emailVerified &&
            Date.now() - new Date(s.session.createdAt).getTime() < 300000
          }
          methods={methods.rows}
          sessions={sessions.rows}
        />
      </Page>,
      status ?? 200,
    );
  };
  app.get("/security", (c) => security(c));
  app.post("/form/:action", async (c) => {
    if (c.req.header("origin") !== AUTH_ORIGIN)
      return json({ error: "same_origin_required" }, 403);
    const raw = await boundedBody(c.req.raw);
    const f = new URLSearchParams(raw);
    if ([...new Set(f.keys())].some((k) => f.getAll(k).length > 1))
      return json({ error: "ambiguous_form" }, 400);
    const action = c.req.param("action");
    const mapping: Record<string, string> = {
      signin: "/sign-in/email",
      signup: "/sign-up/email",
      social: "/sign-in/social",
      forgot: "/request-password-reset",
      verify: "/send-verification-email",
      reset: "/reset-password",
      change: "/change-password",
      link: "/link-social",
      unlink: "/unlink-account",
      revoke: "/revoke-session",
      "revoke-others": "/revoke-other-sessions",
      signout: "/sign-out",
      consent: "/oauth2/consent",
    };
    const path = mapping[action];
    if (!path) return json({ error: "unknown_action" }, 404);
    const body: Record<string, unknown> = Object.fromEntries(f);
    if (body.oauth_query === "") delete body.oauth_query;
    if (action === "consent") body.accept = f.get("accept") === "true";
    else if (["social", "link", "signin", "signup", "verify"].includes(action))
      body.callbackURL = AUTH_ORIGIN + "/security";
    if (action === "change") body.revokeOtherSessions = true;
    if (action === "revoke") {
      const s = await current(c);
      if (!s || Date.now() - new Date(s.session.createdAt).getTime() > 300000)
        return c.redirect("/login", 303);
      const target = await auth.pool.query<{ token: string }>(
        'select token from milton_auth.session where "userId"=$1 and id=$2',
        [s.user.id, f.get("sessionId")],
      );
      if (!target.rows[0]) return json({ error: "session_missing" }, 400);
      body.token = target.rows[0].token;
      delete body.sessionId;
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    // The Turnstile widget's form field becomes the header the wrapper's
    // siteverify check reads; a header the browser sent is never forwarded.
    const captchaToken = f.get("cf-turnstile-response");
    delete body["cf-turnstile-response"];
    headers.delete("x-captcha-response");
    if (action === "signup" && captchaToken)
      headers.set("x-captcha-response", captchaToken);
    const response = await auth.handler(
      new Request(AUTH_ORIGIN + "/api/auth" + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      peer(c),
    );
    const redirectHeaders = new Headers({ "cache-control": "no-store" });
    for (const cookie of response.headers.getSetCookie())
      redirectHeaders.append("set-cookie", cookie);
    let data: Record<string, unknown> = {};
    try {
      data = (await response.clone().json()) as Record<string, unknown>;
    } catch {
      /* Native redirect responses need no JSON body. */
    }
    if (response.status >= 300 && response.status < 400) {
      const destination = response.headers.get("location");
      return destination ? navigate(c, response, destination) : response;
    }
    if (response.ok && typeof data.url === "string")
      return navigate(c, response, data.url);
    if (!response.ok) {
      const key = String(data.error ?? data.code ?? "");
      const messages: Record<string, string> = {
        password_policy:
          "Use 8–128 Unicode characters and avoid common passwords. Spaces are preserved.",
        EMAIL_NOT_VERIFIED:
          "Verify your email before signing in. You can request a new verification email.",
        INVALID_EMAIL_OR_PASSWORD:
          "The email or password could not be verified. Try again or request a password reset.",
        fresh_signin_required:
          "Sign in again before changing your account security.",
        SESSION_NOT_FRESH:
          "Sign in again before changing your account security.",
        FAILED_TO_UNLINK_LAST_ACCOUNT:
          "Keep at least one working sign-in method.",
        rate_limited: "Too many attempts. Wait a minute and try again.",
        captcha_required:
          "Milton could not confirm you are a person. Try again; the check runs on the sign-up page.",
        captcha_refused:
          "Milton could not confirm you are a person. Try again; the check runs on the sign-up page.",
        captcha_unavailable:
          "Milton could not run its check that you are a person. Nothing was created. Try again shortly, or continue with Google or GitHub.",
        busy_retry: "Milton is busy. Try again shortly.",
      };
      const alert =
        messages[key] ??
        (response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "This request could not be completed. Check your details or request a new link.");
      // A password form's refusal shows on that same form, with what was typed
      // except the password. Not a 5xx (its outcome is uncertain), nor a dead
      // reset link, which needs a new email.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        !(action === "reset" && key === "INVALID_TOKEN")
      ) {
        const refusal: Refusal = {
          alert,
          status: response.status === 429 ? 429 : 400,
        };
        const query = new URLSearchParams(f.get("oauth_query") ?? "");
        const email = f.get("email") ?? undefined;
        if (action === "signin") return signIn(c, query, refusal, email);
        if (action === "signup")
          return signUp(c, query, refusal, {
            name: f.get("name") ?? undefined,
            email,
          });
        if (action === "reset")
          return resetPassword(c, f.get("token") ?? "", refusal);
        if (action === "change") return security(c, refusal);
      }
      const retry =
        action === "signup"
          ? "/signup"
          : action === "signin"
            ? "/login"
            : action === "reset"
              ? "/forgot-password"
              : "/security";
      return c.html(
        <Page title="Please try again">
          <p role="alert">
            {key === "captcha_unavailable"
              ? messages[key]
              : response.status === 503
                ? "Milton could not confirm the outcome. Try signing in or request a new link before repeating a security change."
                : alert}
          </p>
          <a href={retry}>Try again</a>
          <p>
            <a href="/verify">Resend verification</a> ·{" "}
            <a href="/forgot-password">Reset password</a>
          </p>
        </Page>,
        response.status === 503 ? 503 : response.status === 429 ? 429 : 400,
      );
    }
    const destination = ["signin", "social", "signout", "reset"].includes(
      action,
    )
      ? "/login"
      : ["signup", "verify"].includes(action)
        ? "/verify"
        : action === "forgot"
          ? "/forgot-password"
          : "/security";
    redirectHeaders.set(
      "location",
      destination + "?notice=" + (response.ok ? "done" : "retry"),
    );
    return new Response(null, { status: 303, headers: redirectHeaders });
  });
  app.onError((_error, c) =>
    c.html(
      <Page title="Please try again">
        <p>
          Milton could not complete this request. Start a new sign-in or request
          a fresh email link.
        </p>
        <a href="/login">Sign in</a>
      </Page>,
      503,
    ),
  );
  app.notFound((c) =>
    c.html(
      <Page title="Page not found">
        <a href="/login">Return to sign in</a>
      </Page>,
      404,
    ),
  );
  return app;
}
