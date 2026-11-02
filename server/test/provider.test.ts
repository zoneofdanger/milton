import { expect, test, setSystemTime } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createAccessTokenVerifier } from "../src/token";

const issuer = "https://auth.example/milton/auth";
const resource = "https://mcp.example/mcp";

test("resource tokens require an EdDSA signature, exact issuer, audience and access claims", async () => {
  const key = await generateKeyPair("EdDSA");
  const other = await generateKeyPair("EdDSA");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "first",
    alg: "EdDSA",
  };
  const requested: string[] = [];
  const verify = createAccessTokenVerifier(
    { issuer, resource },
    async (url) => {
      requested.push(String(url));
      return Response.json({ keys: [jwk] });
    },
  );
  const claims: JWTPayload = {
    iss: issuer,
    aud: [resource, issuer + "/oauth2/userinfo"],
    sub: "neon-fixture",
    client_id: "fixture-client",
    scope: "openid",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const sign = (payload: JWTPayload, signingKey = key.privateKey) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "EdDSA", kid: "first" })
      .sign(signingKey);
  expect(await verify(`Bearer ${await sign(claims)}`)).toMatchObject({
    subject: "neon-fixture",
    clientId: "fixture-client",
    scope: "openid",
  });
  for (const payload of [
    { ...claims, iss: "https://other-branch.example/auth" },
    { ...claims, aud: "https://other.example/mcp" },
    { ...claims, aud: undefined },
    { ...claims, exp: 1 },
    { ...claims, exp: undefined },
    { ...claims, sub: "" },
    { ...claims, client_id: undefined },
    { ...claims, scope: ["openid"] },
    { ...claims, nbf: Math.floor(Date.now() / 1000) + 3600 },
  ])
    await expect(verify(`Bearer ${await sign(payload)}`)).rejects.toMatchObject(
      { status: 401, code: "invalid_token" },
    );
  await expect(
    verify(`Bearer ${await sign(claims, other.privateKey)}`),
  ).rejects.toMatchObject({ status: 401 });
  for (const header of [
    null,
    "Bearer opaque",
    "Bearer legacy-worker-token",
    "Bearer a.b.c, Bearer d.e.f",
  ]) {
    await expect(verify(header)).rejects.toMatchObject({ status: 401 });
  }
  const symmetric = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .sign(crypto.getRandomValues(new Uint8Array(32)));
  await expect(verify(`Bearer ${symmetric}`)).rejects.toMatchObject({
    status: 401,
  });
  expect(requested).toEqual([issuer + "/.well-known/jwks.json"]);
});

test("JWKS keys cache and rotate within bounds; a cold key-service failure is 503", async () => {
  const first = await generateKeyPair("EdDSA");
  const next = await generateKeyPair("EdDSA");
  let keys = [
    { ...(await exportJWK(first.publicKey)), kid: "first", alg: "EdDSA" },
  ];
  let calls = 0;
  const verify = createAccessTokenVerifier({ issuer, resource }, async () => {
    calls++;
    return Response.json({ keys });
  });
  const sign = (kid: string, key: CryptoKey) =>
    new SignJWT({ sub: "fixture", client_id: "client", scope: "" })
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setIssuer(issuer)
      .setAudience(resource)
      .setExpirationTime("1h")
      .sign(key);
  const original = await sign("first", first.privateKey);
  const rotated = await sign("next", next.privateKey);
  await verify(`Bearer ${original}`);
  await verify(`Bearer ${original}`);
  await expect(verify(`Bearer ${rotated}`)).rejects.toMatchObject({
    status: 401,
  });
  expect(calls).toBe(1);
  try {
    setSystemTime(Date.now() + 31000);
    keys = [
      { ...(await exportJWK(next.publicKey)), kid: "next", alg: "EdDSA" },
    ];
    await verify(`Bearer ${rotated}`);
    expect(calls).toBe(2);
  } finally {
    setSystemTime();
  }
  const unavailable = createAccessTokenVerifier(
    { issuer, resource },
    async () => {
      throw new Error("fixture key outage");
    },
  );
  await expect(unavailable(`Bearer ${original}`)).rejects.toMatchObject({
    code: "auth_unavailable",
    status: 503,
  });
});
