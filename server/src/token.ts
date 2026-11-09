import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { z } from "zod";

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const accessClaims = z.object({
  sub: z.string().min(1).max(512),
  client_id: z.string().min(1).max(2048),
  azp: z.string().min(1).max(2048),
  scope: z.string().max(2048),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
  jti: z.string().min(1).max(512),
  miltonBinding: z.string().min(1).max(512),
  miltonIdentityIncarnation: z.string().min(1).max(128),
  miltonSecurityGeneration: z.string().min(1).max(128),
});
export const supportedScopes = new Set([
  "openid",
  "profile",
  "email",
  "offline_access",
  "milton:read",
  "milton:write",
]);
const verifiedAccess = Symbol("verifiedAccess");
interface VerifiedAccess {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly binding: string;
  readonly incarnation: string;
  readonly generation: string;
  readonly [verifiedAccess]: true;
}
export type AccessTokenVerifier = (
  authorization: string | null,
) => Promise<VerifiedAccess>;

export function createAccessTokenVerifier(
  config: { issuer: string; resource: string },
  fetchKeys?: (url: string, options: RequestInit) => Promise<Response>,
): AccessTokenVerifier {
  const keys = createRemoteJWKSet(new URL(`${config.issuer}/jwks`), {
    cacheMaxAge: 600000,
    cooldownDuration: 30000,
    timeoutDuration: 5000,
    ...(fetchKeys ? { [customFetch]: fetchKeys } : {}),
  });
  return async (authorization) => {
    const match =
      authorization &&
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
        authorization,
      );
    if (!match || match[1]!.length > 16384)
      throw new AuthError("invalid_token", "Reconnect your AI to Milton.", 401);
    try {
      // Signature verification is followed by live immutable binding status in
      // the HTTP handler, on every request, independently of this JWKS cache.
      const { payload } = await jwtVerify(match[1]!, keys, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["EdDSA"],
        typ: "at+jwt",
        requiredClaims: ["iss", "aud", "sub", "exp", "client_id", "scope"],
        clockTolerance: 30,
      });
      const claims = accessClaims.safeParse(payload);
      const scopes = claims.success ? claims.data.scope.split(" ") : [];
      // Native 1.7.18 adds its fixed UserInfo audience for openid grants.
      // Require MCP and permit only that documented implicit audience.
      const audiences =
        typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
      const allowedAudiences = new Set([
        config.resource,
        ...(scopes.includes("openid")
          ? [config.issuer + "/oauth2/userinfo"]
          : []),
      ]);
      if (
        !claims.success ||
        claims.data.exp <= Date.now() / 1000 ||
        claims.data.iat > Date.now() / 1000 + 30 ||
        claims.data.exp <= claims.data.iat ||
        claims.data.exp - claims.data.iat > 3600 ||
        payload.cnf !== undefined ||
        !audiences.includes(config.resource) ||
        new Set(audiences).size !== audiences.length ||
        audiences.some((a) => !allowedAudiences.has(a)) ||
        claims.data.client_id !== claims.data.azp ||
        !scopes.length ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((s) => !supportedScopes.has(s)) ||
        (scopes.includes("milton:write") && !scopes.includes("milton:read"))
      )
        throw new AuthError(
          "invalid_token",
          "Reconnect your AI to Milton.",
          401,
        );
      return {
        issuer: config.issuer,
        subject: claims.data.sub,
        clientId: claims.data.client_id,
        scope: claims.data.scope,
        expiresAt: claims.data.exp,
        binding: claims.data.miltonBinding,
        incarnation: claims.data.miltonIdentityIncarnation,
        generation: claims.data.miltonSecurityGeneration,
        [verifiedAccess]: true,
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (
        error instanceof errors.JOSEError &&
        [
          "ERR_JWT_EXPIRED",
          "ERR_JWT_CLAIM_VALIDATION_FAILED",
          "ERR_JWT_INVALID",
          "ERR_JWS_INVALID",
          "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
          "ERR_JOSE_ALG_NOT_ALLOWED",
          "ERR_JOSE_NOT_SUPPORTED",
          "ERR_JWKS_NO_MATCHING_KEY",
        ].includes(error.code)
      )
        throw new AuthError(
          "invalid_token",
          "Reconnect your AI to Milton.",
          401,
        );
      throw new AuthError(
        "auth_unavailable",
        "Sign-in verification is unavailable. Try again.",
        503,
      );
    }
  };
}
