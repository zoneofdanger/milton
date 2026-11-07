import { databaseOptions } from "./database.ts";
import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { getCurrentAuthEndpointContext } from "@better-auth/core/context";
import { jwt } from "better-auth/plugins";
import {
  getOAuthProviderState,
  oauthProvider,
} from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import type { DBFieldAttribute } from "@better-auth/core/db";
import { PostgresDialect } from "kysely";
import pg from "pg";
import {
  AUTH_ORIGIN,
  APP_ORIGIN,
  ISSUER,
  MCP_RESOURCE,
  SCOPES,
  safeError,
  type Config,
} from "./config.ts";
import { credentialAdapter, transport, type RequestState } from "./adapter.ts";
import { acceptMail, stashMail } from "./mail.ts";
import { validPassword } from "./password.ts";
import {
  boundedBody,
  guardRequest,
  json,
  nativeEndpointEnabled,
} from "./http.ts";

export type Boundaries = {
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  beforeMailStash?: (state: RequestState) => void;
};
/** Any https client metadata URL on a DNS name. The plugin also refuses
 * private hosts, and fetchClientMetadataResource pins public addresses. */
export function metadataDocumentUrlAllowed(clientIdUrl: string): boolean {
  if (!URL.canParse(clientIdUrl)) return false;
  const url = new URL(clientIdUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !clientIdUrl.includes("#") &&
    isIP(host) === 0 &&
    host !== "localhost" &&
    !host.endsWith(".localhost")
  );
}
const invalid = () => new APIError("BAD_REQUEST", { error: "invalid_grant" });
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function createProvider(
  config: Config,
  options: { pool?: pg.Pool; owner?: boolean; boundaries?: Boundaries } = {},
) {
  const pool =
    options.pool ??
    new pg.Pool({
      ...databaseOptions(config.AUTH_DATABASE_URL),
      max: 8,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      query_timeout: 6000,
    });
  pool.on("error", (error) => console.error("auth_database", safeError(error)));
  const networkFetch = options.boundaries?.fetch ?? fetch;
  const field: DBFieldAttribute = {
    type: "string",
    input: false,
    returned: false,
    required: false,
  };
  const fields = {
    miltonIdentityIncarnation: field,
    miltonSecurityGeneration: field,
  };
  function mail(input: Parameters<typeof stashMail>[1]) {
    const state = transport.getStore();
    if (!state) throw new Error("missing_mail_request_context");
    try {
      options.boundaries?.beforeMailStash?.(state);
      stashMail(state, input);
    } catch {
      state.mailFault = true;
    }
  }
  async function correlate(
    context: {
      user?: { id: string; emailVerified: boolean; email: string };
      session?: { id: string };
      scopes: string[];
    },
    create: boolean,
  ) {
    if (!context.user?.emailVerified || !context.session) throw invalid();
    if (
      context.scopes.includes("milton:write") &&
      !context.scopes.includes("milton:read")
    )
      throw invalid();
    await getCurrentAuthEndpointContext();
    const oauth = await getOAuthProviderState();
    const q = new URLSearchParams(oauth?.query);
    const tuple = [
      q.get("client_id"),
      q.get("redirect_uri"),
      q.get("code_challenge"),
      q.get("code_challenge_method"),
      q.getAll("resource").sort(),
      q.get("state"),
      q.get("nonce"),
    ];
    if (!tuple[0] || !tuple[1] || !tuple[2] || tuple[3] !== "S256")
      throw invalid();
    if (
      tuple[0] === config.AUTH_APP_CLIENT_ID &&
      (q.get("redirect_uri") !== APP_ORIGIN + "/auth/callback" ||
        q.getAll("resource").length ||
        context.scopes.some((s) => !["openid", "profile", "email"].includes(s)))
    )
      throw invalid();
    if (
      q.getAll("resource").includes(MCP_RESOURCE) &&
      !context.scopes.includes("milton:read")
    )
      throw invalid();
    const continuation = hash(JSON.stringify(tuple));
    await admit(context.user.id, context.session.id, continuation);
    try {
      const r = await pool.query<{ reference: string }>(
        "SELECT * FROM milton_guard.bind_flow($1,$2,$3,$4,$5,$6,$7)",
        [
          continuation,
          context.user.id,
          context.session.id,
          tuple[0],
          tuple[4],
          context.scopes,
          create,
        ],
      );
      if (!r.rows[0]) throw invalid();
      return r.rows[0].reference;
    } catch (e) {
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        ["23514", "P0002"].includes(String(e.code))
      )
        throw invalid();
      throw e;
    }
  }
  async function claims(input: {
    referenceId?: string;
    user?: { id: string } | null;
    client: { clientId: string };
    scopes: string[];
    resources?: string[];
  }) {
    const r = await pool.query<{ binding: Record<string, string> | null }>(
      "SELECT milton_guard.binding_status($1,$2,$3,$4,$5) AS binding",
      [
        input.referenceId ?? "",
        input.user?.id ?? "",
        input.client.clientId,
        input.scopes,
        input.resources ?? [],
      ],
    );
    const b = r.rows[0]?.binding;
    if (!b) throw invalid();
    return {
      miltonBinding: b.reference,
      miltonIdentityIncarnation: b.miltonIdentityIncarnation,
      miltonSecurityGeneration: b.miltonSecurityGeneration,
    };
  }
  type Identity = {
    verifiedEmail: string;
    verifiedIdentities: { provider: "google" | "github"; subject: string }[];
  };
  async function admit(subject: string, sid: string, continuation: string) {
    const original = transport.getStore()?.users.get(subject);
    if (!original) throw invalid();
    const result = await pool.query<{ identity: Identity | null }>(
      "select milton_guard.admission_identity($1,$2,$3,$4) as identity",
      [
        subject,
        sid,
        original.miltonIdentityIncarnation,
        original.miltonSecurityGeneration,
      ],
    );
    const identity = result.rows[0]?.identity;
    if (!identity) throw invalid();
    const response = await networkFetch(APP_ORIGIN + "/internal/auth/admit", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: `Bearer ${config.AUTH_ADMISSION_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        issuer: ISSUER,
        subject,
        continuation,
        ...identity,
      }),
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new APIError("SERVICE_UNAVAILABLE", {
        error: "admission_retry_required",
      });
  }
  const provider = betterAuth({
    baseURL: AUTH_ORIGIN,
    basePath: "/api/auth",
    secret: config.AUTH_SECRET,
    database: options.owner
      ? {
          dialect: new PostgresDialect({ pool }),
          type: "postgres",
          schemaName: "milton_auth",
          transaction: true,
        }
      : credentialAdapter(pool),
    onAPIError: { throw: true },
    logger: { disabled: true },
    trustedOrigins: [AUTH_ORIGIN],
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: true,
      crossSubDomainCookies: { enabled: false },
      database: { joins: true },
      ipAddress: { ipAddressHeaders: ["x-milton-transport-ip"] },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
    },
    session: {
      expiresIn: 604800,
      updateAge: 86400,
      freshAge: 300,
      cookieCache: { enabled: false },
      ...(options.owner ? {} : { additionalFields: fields }),
    },
    user: {
      deleteUser: { enabled: false },
      changeEmail: { enabled: false },
      ...(options.owner ? {} : { additionalFields: fields }),
    },
    account: {
      storeAccountCookie: false,
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
      ...(options.owner
        ? {}
        : {
            additionalFields: {
              miltonCredentialRevision: field,
              miltonExpectedCredentialRevision: field,
            },
          }),
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 15,
      maxPasswordLength: 256,
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      sendResetPassword: async ({ user, token, url }) =>
        mail({ user, url, token, kind: "reset" }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url, token }) =>
        mail({ user, url, token, kind: "verify" }),
    },
    socialProviders: {
      google: {
        clientId: config.AUTH_GOOGLE_CLIENT_ID,
        clientSecret: config.AUTH_GOOGLE_CLIENT_SECRET,
        disableIdTokenSignIn: true,
        requireEmailVerification: true,
      },
      github: {
        clientId: config.AUTH_GITHUB_CLIENT_ID,
        clientSecret: config.AUTH_GITHUB_CLIENT_SECRET,
        disableIdTokenSignIn: true,
        requireEmailVerification: true,
      },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 120 },
    disabledPaths: [
      "/token",
      "/delete-user",
      "/delete-user/callback",
      "/change-email",
      "/update-user",
      "/update-session",
      "/set-password",
      "/oauth2/update-consent",
      "/oauth2/delete-consent",
    ],
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({
            data:
              account.providerId === "credential"
                ? account
                : {
                    ...account,
                    accessToken: null,
                    refreshToken: null,
                    idToken: null,
                    accessTokenExpiresAt: null,
                    refreshTokenExpiresAt: null,
                  },
          }),
        },
        update: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          }),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const s = transport.getStore();
        if (!options.owner && (!s || !nativeEndpointEnabled(ctx.path)))
          throw new APIError("FORBIDDEN", {
            error: "native_http_context_required",
          });
        const body =
          ctx.body && typeof ctx.body === "object"
            ? (ctx.body as Record<string, unknown>)
            : {};
        if (
          ["/sign-up/email", "/change-password", "/reset-password"].includes(
            ctx.path,
          )
        ) {
          const password =
            ctx.path === "/change-password"
              ? body.newPassword
              : ctx.path === "/reset-password"
                ? body.newPassword
                : body.password;
          if (!validPassword(password))
            throw new APIError("BAD_REQUEST", {
              error: "password_policy",
              message:
                "Use 15–128 Unicode characters; avoid common passwords. Spaces are preserved.",
            });
        }
        if (
          ["/sign-in/social", "/link-social"].includes(ctx.path) &&
          (body.idToken ||
            body.additionalData ||
            body.additionalParams ||
            body.scopes ||
            !["google", "github"].includes(String(body.provider)))
        )
          throw new APIError("FORBIDDEN", {
            error: "web_social_flow_required",
          });
        if (
          [
            "/link-social",
            "/unlink-account",
            "/revoke-session",
            "/revoke-sessions",
            "/revoke-other-sessions",
          ].includes(ctx.path)
        ) {
          const session = await getSessionFromCtx(ctx, {
            disableCookieCache: true,
          });
          if (
            !session?.user.emailVerified ||
            Date.now() - new Date(session.session.createdAt).getTime() > 300000
          )
            throw new APIError("FORBIDDEN", { error: "fresh_signin_required" });
        }
        if (ctx.path === "/unlink-account") {
          const original = s?.subject && s.users.get(s.subject);
          if (!original || !s?.securitySession) throw invalid();
          // This happens before native enters the removal transaction. The app
          // reads native status and persists metadata without a parent-lock cycle.
          const response = await networkFetch(
            APP_ORIGIN + "/internal/auth/preserve-eligibility",
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(5000),
              headers: {
                authorization: `Bearer ${config.AUTH_ADMISSION_SECRET}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                issuer: ISSUER,
                subject: original.id,
                sid: s.securitySession.id,
                incarnation: original.miltonIdentityIncarnation,
                generation: original.miltonSecurityGeneration,
              }),
            },
          );
          await response.body?.cancel();
          if (!response.ok)
            throw new APIError("SERVICE_UNAVAILABLE", {
              error: "eligibility_preservation_retry_required",
            });
        }
        if (ctx.path === "/change-password")
          return {
            context: { ...ctx, body: { ...body, revokeOtherSessions: true } },
          };
      }),
    },
    plugins: [
      jwt({ jwt: { issuer: ISSUER }, disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        ...(options.owner
          ? {}
          : {
              postLogin: {
                page: "/admission",
                shouldRedirect: async (c) => {
                  await correlate(c, true);
                  return false;
                },
                consentReferenceId: (c) => correlate(c, false),
              },
              extensions: [
                { claims: { accessToken: claims, idToken: claims } },
              ],
            }),
        scopes: SCOPES,
        resources: [
          {
            identifier: MCP_RESOURCE,
            allowedScopes: SCOPES,
            accessTokenTtl: 3600,
          },
        ],
        enforcePerClientResources: true,
        resourcePrivileges: async () => options.owner === true,
        clientPrivileges: async () => options.owner === true,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: [
          "openid",
          "offline_access",
          "milton:read",
        ],
        clientRegistrationAllowedScopes: SCOPES,
        clientRegistrationDefaultResources: options.owner ? [] : [MCP_RESOURCE],
        clientRegistrationAllowedResources: [MCP_RESOURCE],
        clientRegistrationRequirePKCE: true,
        dpop: { signingAlgorithms: [] },
        advertisedMetadata: {
          claims_supported: [
            "sub",
            "iss",
            "aud",
            "exp",
            "iat",
            "sid",
            "scope",
            "azp",
            "client_id",
            "miltonBinding",
            "miltonIdentityIncarnation",
            "miltonSecurityGeneration",
          ],
        },
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 3600,
        refreshTokenExpiresIn: 2592000,
        codeExpiresIn: 600,
        refreshTokenReuseInterval: 0,
      }),
      cimd({
        fetchClientMetadataResource,
        originBoundFields: ["post_logout_redirect_uris"],
        metadataProfile: "mcp-2026-07-28",
        isMetadataDocumentUrlAllowed: metadataDocumentUrlAllowed,
      }),
    ],
  });
  let inFlight = 0;
  async function handler(
    request: Request,
    peer = "127.0.0.1",
  ): Promise<Response> {
    const denied = guardRequest(request);
    if (denied) return denied;
    const u = new URL(request.url),
      path = u.pathname.slice(9);
    let acquired = false;
    let source = "";
    let body: Record<string, unknown> = {};
    try {
      source = await boundedBody(request);
      if (source)
        body = request.headers
          .get("content-type")
          ?.startsWith("application/json")
          ? JSON.parse(source)
          : Object.fromEntries(new URLSearchParams(source));
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json({ error: "invalid_body" }, 400);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (path === "/oauth2/register" && request.headers.has("authorization"))
      return json({ error: "public_registration_only" }, 403);
    if (
      path.startsWith("/oauth2/") &&
      (body.client_assertion ||
        request.headers.has("dpop") ||
        ["dpop_jkt", "claims", "request", "request_uri"].some((k) =>
          u.searchParams.has(k),
        ) ||
        body.dpop_jkt ||
        body.claims ||
        (body.token_endpoint_auth_method &&
          !["none", "client_secret_post", "client_secret_basic"].includes(
            String(body.token_endpoint_auth_method),
          )))
    )
      return json({ error: "unsupported_oauth_profile" }, 400);
    if (
      path.startsWith("/oauth2/") &&
      Object.keys(body).some(
        (k) =>
          k.startsWith("backchannel_") ||
          [
            "enable_end_session",
            "skip_consent",
            "require_pkce",
            "client_credentials_scopes",
            "metadata",
            "cnf",
            "dpop_jkt",
            "token_binding",
            "dpop_bound_access_tokens",
            "jwks",
            "jwks_uri",
            "subject_type",
            "post_logout_redirect_uris",
          ].includes(k),
      )
    )
      return json({ error: "client_capability_refused" }, 400);
    if (
      path === "/oauth2/introspect" &&
      (request.method !== "POST" ||
        request.headers.has("authorization") ||
        body.client_id !== config.AUTH_APP_CLIENT_ID ||
        !request.headers
          .get("content-type")
          ?.startsWith("application/x-www-form-urlencoded") ||
        [
          "client_id",
          "client_secret",
          "client_assertion",
          "client_assertion_type",
        ].some((k) => u.searchParams.has(k)) ||
        body.client_assertion)
    )
      return json({ error: "introspection_caller_refused" }, 403);
    if (
      source &&
      request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    ) {
      const f = new URLSearchParams(source);
      if ([...new Set(f.keys())].some((k) => f.getAll(k).length > 1))
        return json({ error: "ambiguous_form" }, 400);
    }
    if (inFlight >= 4) return json({ error: "busy_retry" }, 429);
    inFlight++;
    acquired = true;
    const ip = isIP(peer) ? peer : "127.0.0.1";
    const rate = (v: string) =>
      createHmac("sha256", config.AUTH_RATE_SECRET).update(v).digest("hex");
    try {
      const network = await pool.query<{ allowed: boolean }>(
        "select milton_guard.take_rate($1,$2,$3) as allowed",
        [rate("network:" + ip), 60, 120],
      );
      if (!network.rows[0]?.allowed)
        return json({ error: "rate_limited" }, 429);
      if (typeof body.email === "string") {
        const account = await pool.query<{ allowed: boolean }>(
          "select milton_guard.take_rate($1,$2,$3) as allowed",
          [rate("account:" + body.email.toLowerCase()), 60, 10],
        );
        if (!account.rows[0]?.allowed)
          return json({ error: "rate_limited" }, 429);
      }
      const headers = new Headers(request.headers);
      for (const k of [
        "forwarded",
        "x-forwarded-for",
        "x-real-ip",
        "x-client-ip",
        "x-milton-transport-ip",
      ])
        headers.delete(k);
      headers.set("x-milton-transport-ip", ip);
      if (path === "/oauth2/register") headers.delete("cookie");
      if (path === "/request-password-reset") {
        body.redirectTo = AUTH_ORIGIN + "/reset-password";
        source = headers.get("content-type")?.startsWith("application/json")
          ? JSON.stringify(body)
          : new URLSearchParams(body as Record<string, string>).toString();
      }
      const native = new Request(request.url, {
        method: request.method,
        headers,
        ...(request.method === "POST" ? { body: source } : {}),
        signal: request.signal,
      });
      const requestState: RequestState = {
        path,
        cleanupPath:
          path === "/oauth2/revoke" ||
          (path === "/oauth2/token" && body.grant_type === "refresh_token"),
        revokePath: path === "/oauth2/revoke",
        clientId:
          typeof body.client_id === "string" ? body.client_id : undefined,
        users: new Map(),
        credentials: new Map(),
      };
      const response = await transport.run(requestState, async () => {
        const response = await provider.handler(native);
        if (
          response.status < 400 &&
          requestState.linkedSubject &&
          requestState.securitySession &&
          requestState.linkedIdentity
        ) {
          await admit(
            requestState.linkedSubject,
            requestState.securitySession.id,
            hash(
              JSON.stringify([
                "native-link",
                requestState.linkedSubject,
                requestState.securitySession.id,
                path,
                requestState.linkedIdentity.provider,
                requestState.linkedIdentity.subject,
              ]),
            ),
          );
        }
        if (
          response.status >= 500 ||
          requestState.mailFault ||
          (requestState.mailExpected && !requestState.mail)
        )
          throw new Error("native_mail_or_handler_failure");
        const generic =
          [
            "/sign-up/email",
            "/send-verification-email",
            "/request-password-reset",
          ].includes(path) &&
          (response.ok ||
            (path === "/send-verification-email" &&
              response.status === 400 &&
              ((await response.clone().json()) as { code?: string }).code ===
                "EMAIL_ALREADY_VERIFIED"));
        if (generic || requestState.mail)
          await acceptMail(pool, config, requestState);
        if (generic)
          return json({
            message:
              "If this address can receive a message, check your email. You can retry shortly.",
          });
        return response;
      });
      if (path.startsWith("/.well-known/") && response.ok) {
        const metadata = (await response.json()) as Record<string, unknown>;
        metadata.token_endpoint_auth_methods_supported = [
          "none",
          "client_secret_basic",
          "client_secret_post",
        ];
        metadata.introspection_endpoint_auth_methods_supported = [
          "client_secret_post",
        ];
        metadata.revocation_endpoint_auth_methods_supported = [
          "client_secret_basic",
          "client_secret_post",
        ];
        delete metadata.dpop_signing_alg_values_supported;
        delete metadata.token_endpoint_auth_signing_alg_values_supported;
        delete metadata.introspection_endpoint_auth_signing_alg_values_supported;
        delete metadata.revocation_endpoint_auth_signing_alg_values_supported;
        metadata.backchannel_logout_supported = false;
        metadata.backchannel_logout_session_supported = false;
        return json(metadata);
      }
      if (
        response.ok &&
        [
          "/get-session",
          "/list-sessions",
          "/sign-in/email",
          "/sign-in/social",
          "/change-password",
        ].includes(path) &&
        response.headers.get("content-type")?.includes("application/json")
      ) {
        const clean = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(clean)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value)
                    .filter(
                      ([key]) =>
                        ![
                          "token",
                          "password",
                          "accessToken",
                          "refreshToken",
                          "idToken",
                        ].includes(key),
                    )
                    .map(([key, v]) => [key, clean(v)]),
                )
              : value;
        const data = clean(await response.json());
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers,
        });
      }
      if (response.status >= 500)
        return json({ error: "retryable_dependency_failure" }, 503);
      return response;
    } catch (error) {
      console.error("auth_request", safeError(error));
      return json({ error: "retryable_dependency_failure" }, 503);
    } finally {
      if (acquired) inFlight--;
    }
  }
  return { provider, pool, handler };
}
export type AuthService = ReturnType<typeof createProvider>;
