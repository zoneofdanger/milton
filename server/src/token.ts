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
  scope: z.string().max(2048),
  exp: z.number().int().positive(),
});
const verifiedAccess = Symbol("verifiedAccess");
export interface VerifiedAccess {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly [verifiedAccess]: true;
}
export type AccessTokenVerifier = (
  authorization: string | null,
) => Promise<VerifiedAccess>;

export function createAccessTokenVerifier(
  config: { issuer: string; resource: string },
  fetchKeys?: (url: string, options: RequestInit) => Promise<Response>,
): AccessTokenVerifier {
  const keys = createRemoteJWKSet(
    new URL(`${config.issuer}/.well-known/jwks.json`),
    {
      cacheMaxAge: 600000,
      cooldownDuration: 30000,
      timeoutDuration: 5000,
      ...(fetchKeys ? { [customFetch]: fetchKeys } : {}),
    },
  );
  return async (authorization) => {
    const match =
      authorization &&
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
        authorization,
      );
    if (!match || match[1]!.length > 16384)
      throw new AuthError(
        "invalid_token",
        "Reconnect your assistant to Milton.",
        401,
      );
    try {
      // Locally verified access JWTs remain valid for up to Neon's one-hour
      // lifetime after grant revocation. A disconnected assistant is refused
      // after verification, by the account lookup in handler.ts.
      const { payload } = await jwtVerify(match[1]!, keys, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["EdDSA"],
        requiredClaims: ["iss", "aud", "sub", "exp", "client_id", "scope"],
        clockTolerance: 30,
      });
      const claims = accessClaims.safeParse(payload);
      if (!claims.success || claims.data.exp <= Date.now() / 1000)
        throw new AuthError(
          "invalid_token",
          "Reconnect your assistant to Milton.",
          401,
        );
      return {
        issuer: config.issuer,
        subject: claims.data.sub,
        clientId: claims.data.client_id,
        scope: claims.data.scope,
        expiresAt: claims.data.exp,
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
          "Reconnect your assistant to Milton.",
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
