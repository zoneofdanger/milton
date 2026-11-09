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
import {
  decodeBasicCredentials,
  parseAccessTokenAuthorization,
} from "@better-auth/core/oauth2";
import { captcha, jwt } from "better-auth/plugins";
import {
  getOAuthProviderState,
  oauthProvider,
} from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import type { DBFieldAttribute } from "@better-auth/core/db";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { decodeJwt } from "jose";
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
import { mailDomain, type MailDomain } from "./mail-domain.ts";
import { admissionClient } from "./admission.ts";
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
  /** Whether DNS says a domain takes mail; real DNS (mailDomain) by default. */
  mailDomain?: (domain: string) => Promise<MailDomain>;
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
// Final, not a retry: the app answered an admission 410, the account's
// deletion having begun. Whichever path admits, the person reads this.
const ACCOUNT_DELETING = {
  error: "account_deleting",
  message: "This Milton account is being deleted.",
};
const accountDeleting = () => new APIError("FORBIDDEN", ACCOUNT_DELETING);
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
      // Plain PostgreSQL only: Neon drops connect-time settings, so production's
      // limit is the role setting in server/migrations/007-role-timeouts.up.sql.
      statement_timeout: 5000,
      query_timeout: 6000,
    });
  pool.on("error", (error) => console.error("auth_database", safeError(error)));
  // Every rate bucket, native or the wrapper's, is an HMAC'd key in
  // milton_guard.take_rate: one atomic statement, no plain address stored.
  const rate = (v: string) =>
    createHmac("sha256", config.AUTH_RATE_SECRET).update(v).digest("hex");
  const admission = admissionClient(config, options.boundaries?.fetch ?? fetch);
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
    const state = transport.getStore();
    if (!state) throw invalid();
    const user = context.user.id,
      sid = context.session.id;
    const original = state.users.get(user);
    // Native asks twice in one request: authorize calls shouldRedirect then
    // consentReferenceId, and a consent accept calls consentReferenceId then
    // authorize's, each with the same session and stored query. So a request
    // asks the app once: a later ask with every admission input the same
    // shares the first's outcome, a refusal included, and a differing input
    // admits afresh. Each ask still runs its own bind_flow, so a session or
    // binding that ends between the two is refused at the second. Nothing
    // outlives the request.
    const key = JSON.stringify([
      user,
      sid,
      original?.miltonIdentityIncarnation,
      original?.miltonSecurityGeneration,
      continuation,
    ]);
    let admitted = state.admissions.get(key);
    if (!admitted) {
      admitted = admit(user, sid, continuation);
      state.admissions.set(key, admitted);
    }
    await admitted;
    try {
      const r = await pool.query<{ reference: string }>(
        "SELECT * FROM milton_guard.bind_flow($1,$2,$3,$4,$5,$6,$7)",
        [continuation, user, sid, tuple[0], tuple[4], context.scopes, create],
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
  // UserInfo answers only while the token's binding is live, the check MCP
  // and the app make on every call: native checks a JWT's signature and
  // session, never its binding. A JWT's claims are read here unverified and
  // native then verifies the signature of the same token, so a forged claim
  // passes neither; its client is `azp`, the claim native validates. An
  // opaque token is looked up by its stored hash, as the rate gate's app
  // proof does. Anything unreadable is refused.
  async function liveBinding(token: string | undefined, stored: string) {
    if (!token) return false;
    if (token.split(".").length === 3) {
      let c: Record<string, unknown>;
      try {
        c = decodeJwt(token);
      } catch {
        return false;
      }
      const text = (v: unknown) => (typeof v === "string" && v ? v : null);
      const [binding, subject, client, scope, incarnation, generation] = [
        c.miltonBinding,
        c.sub,
        c.azp,
        c.scope,
        c.miltonIdentityIncarnation,
        c.miltonSecurityGeneration,
      ].map(text);
      if (
        !binding ||
        !subject ||
        !client ||
        !scope ||
        !incarnation ||
        !generation
      )
        return false;
      const r = await pool.query<{ b: Record<string, string> | null }>(
        "SELECT milton_guard.binding_status($1,$2,$3,$4,ARRAY[]::text[]) AS b",
        [binding, subject, client, scope.split(" ")],
      );
      const b = r.rows[0]?.b;
      return (
        b?.reference === binding &&
        b.miltonIdentityIncarnation === incarnation &&
        b.miltonSecurityGeneration === generation
      );
    }
    const r = await pool.query<{ live: boolean }>(
      `SELECT exists(SELECT 1 FROM milton_auth."oauthAccessToken" t WHERE t."token"=$1 AND milton_guard.binding_status(coalesce(t."referenceId",''),coalesce(t."userId",''),t."clientId",array(SELECT jsonb_array_elements_text(t."scopes")),array(SELECT jsonb_array_elements_text(t."resources"))) IS NOT NULL) AS live`,
      [stored],
    );
    return r.rows[0]?.live === true;
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
    const admitted = await admission("/internal/auth/admit", {
      issuer: ISSUER,
      subject,
      continuation,
      ...identity,
    });
    // A deletion that began after the identity read above: final, not a retry.
    if (admitted === "deleting") throw accountDeleting();
    if (admitted !== true)
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
    rateLimit: {
      enabled: true,
      // Native decides per address and path ("ip|path") in one take_rate
      // call; its default per-path 120/minute repeats the wrapper's network
      // bucket, so only the rules below cost a round trip.
      customStorage: {
        consume: async (key, rule) => {
          const r = await pool.query<{ allowed: boolean }>(
            "select milton_guard.take_rate($1,$2,$3) as allowed",
            [rate("native:" + key), rule.window, rule.max],
          );
          return { allowed: r.rows[0]?.allowed === true, retryAfter: null };
        },
      },
      // The first matching key wins. These replace native's built-in sign-in
      // and mail rules and the OAuth plugin's, so every native limit is here;
      // README's table gives each one's reason.
      customRules: {
        // Password guessing per address (Better Auth's default).
        "/sign-in/*": { window: 10, max: 3 },
        "/sign-up/*": { window: 10, max: 3 },
        "/change-password": { window: 10, max: 3 },
        // Each sends mail (Better Auth's default).
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
        // Called from servers that share addresses: the wrapper keys these
        // per client or token instead (see handler).
        "/oauth2/token": false,
        "/oauth2/introspect": false,
        "/oauth2/revoke": false,
        "/oauth2/userinfo": false,
        // A person's browser (the OAuth plugin's default).
        "/oauth2/authorize": { window: 60, max: 30 },
        // Every registration is a permanent anonymous client row with no
        // cleanup, so storage sets this: 20 a minute caps one address at
        // 28,800 rows a day, while still admitting 20 new connections a
        // minute through one assistant's egress (native's 5 refused the 6th).
        "/oauth2/register": { window: 60, max: 20 },
        "/**": false,
      },
    },
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
          if (
            (await admission("/internal/auth/preserve-eligibility", {
              issuer: ISSUER,
              subject: original.id,
              sid: s.securitySession.id,
              incarnation: original.miltonIdentityIncarnation,
              generation: original.miltonSecurityGeneration,
            })) !== true
          )
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
        // Native OAuth limits are rateLimit.customRules above.
        rateLimit: {
          token: false,
          authorize: false,
          introspect: false,
          revoke: false,
          register: false,
          rotateClientKeys: false,
          userinfo: false,
        },
      }),
      cimd({
        fetchClientMetadataResource,
        originBoundFields: ["post_logout_redirect_uris"],
        metadataProfile: "mcp-2026-07-28",
        isMetadataDocumentUrlAllowed: metadataDocumentUrlAllowed,
      }),
      // Email sign-up only, after native's rate limits: the token in
      // x-captcha-response is checked with Cloudflare's siteverify (with the
      // derived client address), for this host and the widget's action. A
      // missing or refused token is 400/403. Siteverify unreachable or failing
      // (10 s plugin limit) is native's 500, which the handler answers as a
      // retryable 503: fail closed, nothing is created.
      ...(config.AUTH_TURNSTILE_SECRET_KEY
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: config.AUTH_TURNSTILE_SECRET_KEY,
              endpoints: ["/sign-up/email"],
              expectedAction: "signup",
              allowedHostnames: [new URL(AUTH_ORIGIN).hostname],
            }),
          ]
        : []),
    ],
  });
  let inFlight = 0;
  // The peer keys the network rate limits, so every caller names the client.
  async function handler(request: Request, peer: string): Promise<Response> {
    const denied = guardRequest(request);
    if (denied) return denied;
    const u = new URL(request.url),
      path = u.pathname.slice(9);
    let acquired = false;
    let source = "";
    let body: Record<string, unknown> = {};
    // Native lowercases the type and parses by it, so every body guard below
    // reads this one value, and native is sent only this value. Any other POST
    // type is refused before native, as is a combined (comma-joined) header,
    // whose later types some runtimes' formData() honours.
    const contentType = request.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
    if (
      request.method === "POST" &&
      (contentType.includes(",") ||
        (mediaType !== "application/json" &&
          mediaType !== "application/x-www-form-urlencoded"))
    )
      return json({ error: "unsupported_media_type" }, 415);
    try {
      source = await boundedBody(request);
      // Native is sent the body re-serialised from what the guards read, so
      // no later decode (a BOM strip, another parser) can find a field the
      // guards did not see.
      if (source && mediaType === "application/json") {
        body = JSON.parse(source);
        source = JSON.stringify(body);
      } else if (source) {
        const fields = new URLSearchParams(source);
        body = Object.fromEntries(fields);
        source = fields.toString();
      }
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
        mediaType !== "application/x-www-form-urlencoded" ||
        [
          "client_id",
          "client_secret",
          "client_assertion",
          "client_assertion_type",
        ].some((k) => u.searchParams.has(k)) ||
        body.client_assertion)
    )
      return json({ error: "introspection_caller_refused" }, 403);
    if (source && mediaType === "application/x-www-form-urlencoded") {
      const f = new URLSearchParams(source);
      if ([...new Set(f.keys())].some((k) => f.getAll(k).length > 1))
        return json({ error: "ambiguous_form" }, 400);
    }
    if (path === "/request-password-reset") {
      body.redirectTo = AUTH_ORIGIN + "/reset-password";
      source =
        mediaType === "application/json"
          ? JSON.stringify(body)
          : new URLSearchParams(body as Record<string, string>).toString();
    }
    // Re-encoding can grow the body, so the rebuilt body meets the incoming
    // limit too, before any database work.
    if (Buffer.byteLength(source) > 16384)
      return json({ error: "request_too_large" }, 413);
    if (inFlight >= 4) return json({ error: "busy_retry" }, 429);
    inFlight++;
    acquired = true;
    const ip = isIP(peer) ? peer : "127.0.0.1";
    // Server-side callers (the app, assistant backends) put many people
    // behind one address, so their endpoints are keyed per client (token,
    // revoke) or per access token (UserInfo) and address, not per address.
    // The client is read as native reads it: a Basic header first, else the
    // body. A client or token that is only named, not proven, is keyed on
    // the caller's own address, so it spends nothing of anyone's elsewhere.
    let caller: string | undefined, callerSecret: string | undefined;
    if (
      ["/oauth2/token", "/oauth2/introspect", "/oauth2/revoke"].includes(path)
    ) {
      const authorization = request.headers.get("authorization");
      if (authorization && /^Basic +/i.test(authorization)) {
        try {
          const basic = decodeBasicCredentials(authorization);
          caller = basic.clientId;
          callerSecret = basic.clientSecret;
        } catch {
          // Native refuses it; only the network bucket applies.
        }
      } else {
        if (typeof body.client_id === "string") caller = body.client_id;
        if (typeof body.client_secret === "string")
          callerSecret = body.client_secret;
      }
    }
    // UserInfo's token, read by native's own parser (any scheme, any
    // whitespace), so both always see the same token. The wrapper refuses
    // POST UserInfo, so the header is native's only source.
    const bearer =
      path === "/oauth2/userinfo"
        ? parseAccessTokenAuthorization(
            request.headers.get("authorization") ?? undefined,
          )?.token || undefined
        : undefined;
    // [key, window seconds, max], taken only once the gate admits.
    const account: [string, number, number][] =
      typeof body.email === "string"
        ? [[rate("account:" + body.email.toLowerCase()), 60, 10]]
        : [];
    const scoped: [string, number, number][] = [];
    if (path === "/oauth2/token" && caller)
      scoped.push([rate("client:" + JSON.stringify([caller, ip])), 60, 60]);
    if (path === "/oauth2/revoke" && caller)
      scoped.push([rate("revoke:" + JSON.stringify([caller, ip])), 60, 30]);
    if (bearer)
      scoped.push([rate("userinfo:" + JSON.stringify([bearer, ip])), 60, 60]);
    // The app proves itself by its client secret (token, introspection,
    // revocation) or by one of its own access tokens (UserInfo), each
    // compared with native's stored SHA-256/base64url hash in this same
    // statement. A token proves it only while native would still accept it:
    // unexpired, unrevoked, its client enabled, its session (if any) live,
    // and its binding current by binding_status, the check native's claims
    // extension makes, so a password change or disconnect ends it. A proven
    // app request takes its own per-address ceiling in place of the network
    // bucket and skips the scoped buckets.
    const values: unknown[] = [];
    const $ = (v: unknown) => (values.push(v), `$${values.length}`);
    const stored = (v: string) =>
      createHash("sha256").update(v).digest("base64url");
    const proof =
      caller === config.AUTH_APP_CLIENT_ID && callerSecret
        ? `exists(select 1 from milton_auth."oauthClient" where "clientId"=${$(caller)} and "clientSecret"=${$(stored(callerSecret))} and "disabled" is not true)`
        : bearer
          ? `exists(select 1 from milton_auth."oauthAccessToken" t join milton_auth."oauthClient" c on c."clientId"=t."clientId" where t."token"=${$(stored(bearer))} and t."clientId"=${$(config.AUTH_APP_CLIENT_ID)} and t."revoked" is null and t."expiresAt">clock_timestamp() and c."disabled" is not true and (t."sessionId" is null or exists(select 1 from milton_auth.session s where s.id=t."sessionId" and s."expiresAt">clock_timestamp())) and milton_guard.binding_status(coalesce(t."referenceId",''),coalesce(t."userId",''),t."clientId",array(select jsonb_array_elements_text(t."scopes")),array(select jsonb_array_elements_text(t."resources"))) is not null)`
          : "false";
    const take = ([key, window, max]: [string, number, number]) =>
      `milton_guard.take_rate(${$(key)},${$(window)}::integer,${$(max)}::integer)`;
    const gate = `case when app then ${take([rate("first-party:" + ip), 60, 1000])} else ${take([rate("network:" + ip), 60, 120])} end`;
    const list = (b: [string, number, number][]) =>
      ["true", ...b.map(take)].join(",");
    // The gate decides first. A request it refuses creates and charges no
    // other bucket, so one refused address cannot grow the table or spend
    // a targeted email's bucket. CASE evaluates only the branch it selects,
    // and the volatile CTE runs once.
    const statement = `with g as (select app, ${gate} as admitted from (select ${proof} as app) p) select case when not admitted then array[false] when app then array[${list(account)}] else array[${list([...account, ...scoped])}] end as allowed from g`;
    try {
      const taken = await pool.query<{ allowed: boolean[] }>(statement, values);
      const allowed = taken.rows[0]?.allowed;
      if (!Array.isArray(allowed) || !allowed.every((a) => a === true))
        return json({ error: "rate_limited" }, 429);
      if (
        path === "/oauth2/userinfo" &&
        !(await liveBinding(bearer, bearer ? stored(bearer) : ""))
      ) {
        // RFC 6750 §3: a refused bearer gets its challenge; a request with
        // no credentials gets a bare one.
        const refused = json({ error: "invalid_token" }, 401);
        refused.headers.set(
          "www-authenticate",
          bearer ? 'Bearer error="invalid_token"' : "Bearer",
        );
        return refused;
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
      if (request.method === "POST") headers.set("content-type", mediaType);
      if (path === "/oauth2/register") headers.delete("cookie");
      // The rebuilt body has its own length, and no client header may
      // describe the original bytes.
      for (const k of [
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "content-md5",
        "digest",
        "content-digest",
      ])
        headers.delete(k);
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
        admissions: new Map(),
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
        if (generic || requestState.mail) {
          // Native work is done, and the domain lookup can wait up to 2 s on
          // a name an attacker serves, so acceptance holds no native slot.
          // Its two statements are still bounded by the pool.
          if (acquired) {
            inFlight--;
            acquired = false;
          }
          await acceptMail(pool, config, requestState, {
            domain: options.boundaries?.mailDomain ?? ((d) => mailDomain(d)),
            requested: typeof body.email === "string" ? body.email : undefined,
          });
        }
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
      // The link handoff's admission runs after native answers, outside its
      // error handling, so its final refusal is answered here.
      if (
        error instanceof APIError &&
        (error.body as { error?: unknown } | undefined)?.error ===
          ACCOUNT_DELETING.error
      )
        return json(ACCOUNT_DELETING, 403);
      console.error("auth_request", safeError(error));
      return json({ error: "retryable_dependency_failure" }, 503);
    } finally {
      if (acquired) inFlight--;
    }
  }
  return {
    provider,
    pool,
    handler,
    /** Set only when Turnstile guards sign-up; the page renders its widget. */
    turnstileSiteKey: config.AUTH_TURNSTILE_SECRET_KEY
      ? config.AUTH_TURNSTILE_SITE_KEY
      : undefined,
  };
}
export type AuthService = ReturnType<typeof createProvider>;
