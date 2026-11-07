import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import { isLoopback } from "./config";
import { database } from "./store";
import { AuthError } from "./token";
import {
  appActive,
  authoritySchema,
  invalid,
  unavailable,
} from "./auth-authority";

export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export const cookieName = (config: RuntimeConfig, name: string) =>
  (isLoopback(new URL(config.appOrigin).hostname) ? "" : "__Host-") +
  "milton-" +
  name;

/** Source-supported errors: ClientError's Response cause carries real HTTP 5xx.
 * A spent callback is never automatically retried after an uncertain exchange. */
export function protocolError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  if (
    (error instanceof oidc.ClientError &&
      error.cause instanceof Response &&
      error.cause.status >= 500 &&
      error.cause.status <= 599) ||
    (error instanceof oidc.ResponseBodyError &&
      error.status >= 500 &&
      error.status <= 599) ||
    (error instanceof oidc.ClientError &&
      (["OAUTH_TIMEOUT", "OAUTH_REQUEST_TIMEOUT", "OAUTH_ABORT"].includes(
        error.code ?? "",
      ) ||
        error.cause instanceof TypeError)) ||
    error instanceof TypeError ||
    (error instanceof DOMException &&
      ["TimeoutError", "AbortError"].includes(error.name))
  )
    return unavailable();
  return invalid();
}
const clients = new WeakMap<RuntimeConfig, Promise<oidc.Configuration>>();
export async function oidcClient(config: RuntimeConfig) {
  let pending = clients.get(config);
  if (!pending) {
    pending = (async () => {
      const client = await oidc.discovery(
        new URL(config.issuer),
        config.oidc.clientId,
        {
          id_token_signed_response_alg: "EdDSA",
          token_endpoint_auth_method: "client_secret_post",
        },
        oidc.ClientSecretPost(config.oidc.clientSecret),
        {
          timeout: 5,
          ...(config.authFetch ? { [oidc.customFetch]: config.authFetch } : {}),
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(isLoopback(new URL(config.issuer).hostname)
              ? [oidc.allowInsecureRequests]
              : []),
          ],
        },
      );
      const metadata = client.serverMetadata();
      const endpoints = {
        authorization_endpoint: "/oauth2/authorize",
        token_endpoint: "/oauth2/token",
        userinfo_endpoint: "/oauth2/userinfo",
        jwks_uri: "/jwks",
        introspection_endpoint: "/oauth2/introspect",
        end_session_endpoint: "/oauth2/end-session",
      };
      if (
        metadata.issuer !== config.issuer ||
        Object.entries(endpoints).some(
          ([key, path]) => metadata[key] !== config.issuer + path,
        )
      )
        throw invalid();
      return client;
    })();
    clients.set(config, pending);
    pending.catch(() => clients.delete(config));
  }
  try {
    return await pending;
  } catch (error) {
    throw protocolError(error);
  }
}

export async function beginLogin(
  config: RuntimeConfig,
  destination: "/" | "/account/delete" | "/assistants" = "/",
  fresh = false,
) {
  const client = await oidcClient(config);
  const state = oidc.randomState(),
    nonce = oidc.randomNonce(),
    verifier = oidc.randomPKCECodeVerifier(),
    browser = randomToken();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  try {
    await database(config).transaction(async (tx) => {
      await tx.query(
        sql`DELETE FROM milton_app.flow WHERE state_hash IN(SELECT state_hash FROM milton_app.flow WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 16)`,
      );
      await tx.query(
        sql`DELETE FROM milton_app.session WHERE token_hash IN(SELECT token_hash FROM milton_app.session WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 16)`,
      );
      await tx.query(
        sql`INSERT INTO milton_app.flow(state_hash,browser_hash,nonce,verifier,destination) VALUES(${hash(state)},${hash(browser)},${nonce},${verifier},${destination})`,
      );
    });
  } catch {
    throw unavailable();
  }
  return {
    browser,
    url: oidc.buildAuthorizationUrl(client, {
      response_type: "code",
      redirect_uri: config.appOrigin + "/auth/callback",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(fresh ? { prompt: "login", max_age: "0" } : {}),
    }),
  };
}
const nativeProof = z.object({
  active: z.literal(true),
  sub: z.string().min(1).max(512),
  sid: z.string().min(1).max(512),
  client_id: z.string(),
  exp: z.number().int().positive(),
  scope: z.string(),
  miltonBinding: z.string().min(1).max(512),
  miltonIdentityIncarnation: z.string().min(1).max(128),
  miltonSecurityGeneration: z.string().min(1).max(128),
});
export async function finishLogin(
  config: RuntimeConfig,
  url: URL,
  browser: string | undefined,
) {
  if (
    url.origin !== config.appOrigin ||
    url.pathname !== "/auth/callback" ||
    !browser ||
    !/^[A-Za-z0-9_-]{43}$/.test(browser) ||
    [...new Set(url.searchParams.keys())].some(
      (k) => url.searchParams.getAll(k).length !== 1,
    )
  )
    throw invalid();
  const state = url.searchParams.get("state");
  if (!state || state.length > 512) throw invalid();
  let flow:
    | {
        nonce: string;
        verifier: string;
        destination: "/" | "/account/delete" | "/assistants";
      }
    | undefined;
  try {
    flow = (
      await database(config).query<{
        nonce: string;
        verifier: string;
        destination: "/" | "/account/delete" | "/assistants";
      }>(
        sql`DELETE FROM milton_app.flow WHERE state_hash=${hash(state)} AND browser_hash=${hash(browser)} AND expires_at>clock_timestamp() RETURNING nonce,verifier,destination`,
      )
    )[0];
  } catch {
    throw unavailable();
  }
  if (!flow) throw invalid();
  try {
    const client = await oidcClient(config);
    const tokens = await oidc.authorizationCodeGrant(client, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: state,
      expectedNonce: flow.nonce,
    });
    const claims = tokens.claims();
    if (
      !claims ||
      tokens.refresh_token ||
      !tokens.access_token ||
      tokens.access_token.length > 4096 ||
      !/^[A-Za-z0-9_~+/-]+=*$/.test(tokens.access_token) ||
      tokens.token_type.toLowerCase() !== "bearer" ||
      !tokens.expires_in ||
      tokens.expires_in <= 0 ||
      tokens.expires_in > 3600
    )
      throw invalid();
    const info = await oidc.fetchUserInfo(
      client,
      tokens.access_token,
      claims.sub,
    );
    const proof = nativeProof.safeParse(
      await oidc.tokenIntrospection(client, tokens.access_token),
    );
    if (!proof.success) throw invalid();
    const p = proof.data;
    if (
      p.sub !== claims.sub ||
      claims.sid !== p.sid ||
      info.sub !== p.sub ||
      info.email_verified !== true ||
      !z.email().max(254).safeParse(info.email).success ||
      p.client_id !== config.oidc.clientId ||
      p.exp <= Date.now() / 1000 ||
      !p.scope.split(" ").includes("openid") ||
      p.scope
        .split(" ")
        .some((s) => !["openid", "profile", "email"].includes(s)) ||
      [
        "miltonBinding",
        "miltonIdentityIncarnation",
        "miltonSecurityGeneration",
      ].some((k) => claims[k] !== p[k as keyof typeof p])
    )
      throw invalid();
    const authority = authoritySchema.parse({
      subject: p.sub,
      sid: p.sid,
      binding: p.miltonBinding,
      incarnation: p.miltonIdentityIncarnation,
      generation: p.miltonSecurityGeneration,
    });
    if (!(await appActive(config, authority))) throw invalid();
    const token = randomToken();
    const expires = new Date(
      Math.min(
        Date.now() + 3600000,
        Date.now() + tokens.expires_in * 1000,
        p.exp * 1000,
      ),
    );
    try {
      await database(config).query(
        sql`INSERT INTO milton_app.session(token_hash,issuer,subject,sid,binding,incarnation,generation,email,access_token,expires_at) VALUES(${hash(token)},${config.issuer},${authority.subject},${authority.sid},${authority.binding},${authority.incarnation},${authority.generation},${info.email as string},${tokens.access_token},${expires})`,
      );
    } catch {
      throw unavailable();
    }
    // Fence again after the write: a reset racing the callback never issues a
    // usable cookie; every subsequent use independently rechecks it as well.
    if (!(await appActive(config, authority))) {
      await removeSession(config, token);
      throw invalid();
    }
    return {
      token,
      destination: flow.destination,
      maxAge: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)),
    };
  } catch (error) {
    throw protocolError(error);
  }
}
export async function removeSession(
  config: RuntimeConfig,
  token: string | undefined,
) {
  if (!token) return;
  try {
    await database(config).query(
      sql`DELETE FROM milton_app.session WHERE token_hash=${hash(token)}`,
    );
  } catch {
    throw unavailable();
  }
}
export async function endSessionUrl(config: RuntimeConfig) {
  return oidc.buildEndSessionUrl(await oidcClient(config), {
    client_id: config.oidc.clientId,
    post_logout_redirect_uri: config.appOrigin + "/auth/logged-out",
  });
}
