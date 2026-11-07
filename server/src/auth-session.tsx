/** @jsxImportSource hono/jsx */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { database } from "./store";
import {
  appActive,
  authoritySchema,
  securityStatus,
  unavailable,
  type Authority,
} from "./auth-authority";
import { cookieName, hash } from "./auth-oidc";
import type { RuntimeConfig } from "./config";
import {
  accountTrialStatus,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  type VerifiedStoreAuth,
} from "./store";
import { memoPages } from "./memo-pages";
import { billingItem } from "./pages";
import { AuthError } from "./token";

export type SessionUser = Authority & { id: string; email?: string };
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
/** One request owns its cookies and CSRF closure. App sessions are opaque,
 * identity-only, server-held, absolute-lived and checked against native SQL. */
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
      `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
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
  const session = async (): Promise<SessionUser | null> => {
    const token = cookieValue(request, cookieName(config, "session"));
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    let row: Record<string, unknown> | undefined;
    try {
      row = (
        await database(config).query(
          sql`SELECT subject,sid,binding,incarnation,generation,email FROM milton_app.session WHERE token_hash=${hash(token)} AND issuer=${config.issuer} AND expires_at>clock_timestamp()`,
        )
      )[0];
    } catch {
      throw unavailable();
    }
    const proof = authoritySchema.safeParse(row);
    if (!proof.success || !(await appActive(config, proof.data))) return null;
    return {
      ...proof.data,
      id: proof.data.subject,
      ...(typeof row?.email === "string" ? { email: row.email } : {}),
    };
  };
  const fresh = async (user: SessionUser) => {
    const status = await securityStatus(config, user);
    const parsed = z
      .object({
        fresh: z.literal(true),
        verified: z.literal(true),
        sessionId: z.literal(user.sid),
      })
      .safeParse(status);
    if (!parsed.success)
      throw new AuthError(
        "fresh_sign_in_required",
        "Sign in again before continuing with this account change.",
        403,
      );
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
      provider: config.issuer,
      subject: user.id,
    });
    const store = await personStoreForCurrentRequest(config, verified);
    return memoPages(request, store, csrfField, user.email, {
      billing: !!config.billing,
    });
  };
  // The account menu's billing item on pages that do not read the status anyway.
  // It is chrome: any failure here shows no item, never a failed page.
  const accountBilling = async (user: SessionUser) => {
    if (!config.billing) return undefined;
    try {
      const { userId } = await lookupIdentityAccount(config, {
        provider: config.issuer,
        subject: user.id,
      });
      return billingItem(await accountTrialStatus(config, userId));
    } catch {
      return undefined;
    }
  };
  return {
    config,
    request,
    url,
    csrfName,
    // Set by the sign-in routes; the error page links back to it.
    loginRecovery: undefined as string | undefined,
    cookies,
    writeCookie,
    csrfField,
    rotateCsrf,
    fresh,
    session,
    signedIn,
    readForm,
    renderMemos,
    accountBilling,
  };
}
export type PageContext = ReturnType<typeof pageContext>;
