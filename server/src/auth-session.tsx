/** @jsxImportSource hono/jsx */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createAuthServer,
  extractNeonAuthCookies,
  NEON_AUTH_SESSION_DATA_COOKIE_NAME,
  resolveNeonAuthLogging,
  serializeSetCookie,
} from "@neondatabase/auth/server";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import {
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  type VerifiedStoreAuth,
} from "./store";
import { memoPages } from "./memo-pages";
import { AuthError } from "./token";

const sessionSchema = z.object({
  user: z.object({
    id: z.string().min(1).max(512),
    // Shown only in authenticated page chrome; an unusable value shows nothing.
    email: z.string().min(1).max(254).optional().catch(undefined),
  }),
  session: z.object({ userId: z.string(), expiresAt: z.coerce.date() }),
});
export type SessionUser = z.infer<typeof sessionSchema>["user"];
export const silentLog = resolveNeonAuthLogging({ logLevel: "silent" });
export const cookieValue = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + "="))
    ?.slice(name.length + 1);
const equal = (left: string, right: string) =>
  left.length === right.length &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));
export async function timed<T>(promise: Promise<T>) {
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
export function upstreamError(error: { status?: number } | null) {
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

/** One browser request's session state: the cookies to set, the CSRF token,
 * the Neon auth server reading this request's cookies, and session checks.
 * Created once per request; the CSRF token is private to these closures. */
export function pageContext(
  config: RuntimeConfig,
  request: Request,
  secure: boolean,
  csrfName: string,
) {
  const url = new URL(request.url);
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
  return {
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
    identity,
    readForm,
    renderMemos,
  };
}
export type PageContext = ReturnType<typeof pageContext>;
