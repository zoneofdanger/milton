import type { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { RuntimeConfig } from "../src/config";
import { hash, randomToken } from "../src/auth-oidc";
import { localStore } from "./local-store";
import { fingerprintKeyCheck } from "../src/auth-admission";

export const appOrigin = "http://localhost:3001";
export const issuer = "https://auth.example/api/auth";
export const resource = appOrigin + "/mcp";
export const clientSettings = {
  oidc: {
    clientId: "app-fixture",
    clientSecret: "fictional-app-secret-32-characters",
  },
  admissionSecret: "fictional-admission-secret-32-characters",
  trialFingerprintKey: "fictional-trial-key-32-characters",
};

/** Protocol unit fixture only. Native SQL/roles are exercised separately by the
 * explicit real-PostgreSQL rehearsal; these functions are not native evidence. */
export async function appStorage(pg: PGlite) {
  await pg.exec(
    `CREATE ROLE milton_auth_runtime; CREATE ROLE milton_app_runtime; CREATE ROLE milton_mcp_runtime;`,
  );
  await pg.exec(
    await Bun.file(
      new URL("../migrations/005-app.up.sql", import.meta.url),
    ).text(),
  );
  // `fail` names one lifecycle function (begin_operation or cleanup_operation)
  // that raises for this subject, as a native outage would.
  await pg.exec(`CREATE SCHEMA milton_guard;
    CREATE TABLE milton_guard.fixture_authority(subject text PRIMARY KEY,active boolean DEFAULT true,fresh boolean DEFAULT true,fail text);
    CREATE TABLE milton_guard.fixture_connection(reference text PRIMARY KEY,subject text NOT NULL,client_id text NOT NULL,scopes jsonb NOT NULL DEFAULT '["milton:read"]',active boolean NOT NULL DEFAULT true);
    CREATE TABLE milton_guard.fixture_operation(operation_id text PRIMARY KEY,subject text NOT NULL,incarnation text NOT NULL,client_id text,kind text NOT NULL,progress text NOT NULL DEFAULT 'refused');
    CREATE FUNCTION milton_guard.app_status(text,text,text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$ SELECT active AND NOT EXISTS(SELECT 1 FROM milton_guard.fixture_operation WHERE subject=$2 AND kind='delete') FROM milton_guard.fixture_authority WHERE subject=$2 $$;
    CREATE FUNCTION milton_guard.security_status(text,text,text,text) RETURNS jsonb LANGUAGE SQL AS $$ SELECT jsonb_build_object('fresh',fresh,'verified',true,'sessionId',$4,'verifiedEmail','fixture@example.invalid','verifiedIdentities','[]'::jsonb) FROM milton_guard.fixture_authority WHERE subject=$1 AND active AND NOT EXISTS(SELECT 1 FROM milton_guard.fixture_operation WHERE subject=$1 AND kind='delete') $$;
    CREATE FUNCTION milton_guard.list_connections(text,text,integer) RETURNS jsonb LANGUAGE SQL AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('reference',reference,'client_id',client_id,'scopes',scopes,'expires_at',now()+interval '1 day') ORDER BY reference),'[]'::jsonb) FROM (SELECT * FROM milton_guard.fixture_connection WHERE subject=$1 AND active ORDER BY reference LIMIT $3) c $$;
    CREATE FUNCTION milton_guard.connection_key_status(text,text,text) RETURNS boolean LANGUAGE SQL AS $$ SELECT coalesce((SELECT active FROM milton_guard.fixture_authority WHERE subject=$1),false) AND ($2,$3)=('f:1','f:2') $$;
    -- As native: a retry returns the original operation; a first call revokes the
    -- client's connections (every one for delete) and records the operation.
    CREATE FUNCTION milton_guard.begin_operation(text,text,text,text,text) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE previous milton_guard.fixture_operation;
    BEGIN
     IF EXISTS(SELECT 1 FROM milton_guard.fixture_authority WHERE subject=$2 AND fail='begin_operation') THEN RAISE EXCEPTION 'fixture begin_operation outage'; END IF;
     IF $1 IS NULL OR length($1)<>36 OR $5 NOT IN ('disconnect','delete') OR ($5='disconnect' AND $4 IS NULL) THEN RAISE EXCEPTION 'invalid lifecycle operation'; END IF;
     SELECT * INTO previous FROM milton_guard.fixture_operation WHERE operation_id=$1;
     IF FOUND THEN
      IF (previous.subject,previous.incarnation,previous.client_id,previous.kind) IS DISTINCT FROM ($2,$3,$4,$5) THEN RAISE EXCEPTION 'misbound lifecycle retry'; END IF;
      RETURN $1;
     END IF;
     IF NOT EXISTS(SELECT 1 FROM milton_guard.fixture_authority WHERE subject=$2) OR $3<>'f:1' THEN RAISE EXCEPTION 'missing original identity'; END IF;
     UPDATE milton_guard.fixture_connection SET active=false WHERE subject=$2 AND ($5='delete' OR client_id=$4);
     INSERT INTO milton_guard.fixture_operation(operation_id,subject,incarnation,client_id,kind) VALUES($1,$2,$3,$4,$5);
     RETURN $1;
    END $$;
    -- Finishes in one bounded pass (native may answer 'tokens-cleaned' first).
    CREATE FUNCTION milton_guard.cleanup_operation(text,integer) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE op milton_guard.fixture_operation;
    BEGIN
     IF $2 NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'bounded cleanup required'; END IF;
     SELECT * INTO STRICT op FROM milton_guard.fixture_operation WHERE operation_id=$1 FOR UPDATE;
     IF EXISTS(SELECT 1 FROM milton_guard.fixture_authority WHERE subject=op.subject AND fail='cleanup_operation') THEN RAISE EXCEPTION 'fixture cleanup_operation outage'; END IF;
     UPDATE milton_guard.fixture_operation SET progress='complete' WHERE operation_id=$1;
     RETURN 'complete';
    END $$;
  `);
}
export async function pageFixture(
  subject = "page-fixes",
  extra: Partial<RuntimeConfig> = {},
) {
  const local = await localStore();
  await appStorage(local.pg);
  await local.db.query(
    sql`INSERT INTO milton_app.eligibility_policy(singleton,key_check) VALUES(true,${fingerprintKeyCheck(clientSettings.trialFingerprintKey)})`,
  );
  await local.db.query(
    sql`INSERT INTO milton_guard.fixture_authority(subject) VALUES(${subject})`,
  );
  const token = randomToken();
  await local.db.query(
    sql`INSERT INTO milton_app.session(token_hash,issuer,subject,sid,binding,incarnation,generation,email,access_token,expires_at) VALUES(${hash(token)},${issuer},${subject},'sid','binding','f:1','f:2','fixture@example.invalid','fictional-opaque',now()+interval '1 hour')`,
  );
  return {
    ...local,
    token,
    config: {
      ...local.env,
      ...clientSettings,
      issuer,
      resource,
      appOrigin,
      ...extra,
    } satisfies RuntimeConfig,
  };
}
export async function protocolFixture(config: RuntimeConfig) {
  const key = await generateKeyPair("EdDSA");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "fixture",
    alg: "EdDSA",
  };
  const state = {
    nonce: "",
    challenge: "",
    subject: "oidc-person",
    sid: "sid",
    down: "",
    wrongNonce: false,
    wrongSubject: false,
    wrongIssuer: false,
    wrongAudience: false,
    wrongSid: false,
    expires: 3600,
    calls: [] as string[],
  };
  const metadata = {
    issuer: config.issuer,
    authorization_endpoint: config.issuer + "/oauth2/authorize",
    token_endpoint: config.issuer + "/oauth2/token",
    userinfo_endpoint: config.issuer + "/oauth2/userinfo",
    introspection_endpoint: config.issuer + "/oauth2/introspect",
    end_session_endpoint: config.issuer + "/oauth2/end-session",
    jwks_uri: config.issuer + "/jwks",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["EdDSA"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  };
  const transport: NonNullable<RuntimeConfig["authFetch"]> = async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(config.issuer).origin)
      throw new Error("Unexpected test host");
    const path = url.pathname.slice(new URL(config.issuer).pathname.length);
    state.calls.push(path);
    if (state.down === "network" && path === "/oauth2/token")
      throw new TypeError("Fictional bounded network failure");
    if (state.down === path)
      return Response.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    if (path === "/.well-known/openid-configuration")
      return Response.json(metadata);
    if (path === "/jwks") return Response.json({ keys: [jwk] });
    if (path === "/oauth2/token") {
      const fields = new URLSearchParams(String(init.body));
      if (
        fields.get("client_id") !== config.oidc.clientId ||
        fields.get("client_secret") !== config.oidc.clientSecret ||
        fields.get("redirect_uri") !== config.appOrigin + "/auth/callback" ||
        !fields.get("code_verifier") ||
        createHash("sha256")
          .update(fields.get("code_verifier")!)
          .digest("base64url") !== state.challenge
      )
        return Response.json({ error: "invalid_request" }, { status: 400 });
      const id = await new SignJWT({
        sub: state.subject,
        sid: state.wrongSid ? "another-session" : state.sid,
        nonce: state.wrongNonce ? "wrong" : state.nonce,
        miltonBinding: "binding",
        miltonIdentityIncarnation: "f:1",
        miltonSecurityGeneration: "f:2",
      })
        .setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
        .setIssuer(state.wrongIssuer ? "https://wrong.example" : config.issuer)
        .setAudience(state.wrongAudience ? "other" : config.oidc.clientId)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(key.privateKey);
      return Response.json({
        access_token: "fictional-opaque",
        token_type: "Bearer",
        expires_in: state.expires,
        id_token: id,
        scope: "openid profile email",
      });
    }
    if (path === "/oauth2/userinfo")
      return Response.json({
        sub: state.wrongSubject ? "another" : state.subject,
        email: "person@example.invalid",
        email_verified: true,
      });
    if (path === "/oauth2/introspect")
      return Response.json({
        active: true,
        sub: state.subject,
        sid: state.sid,
        client_id: config.oidc.clientId,
        scope: "openid profile email",
        exp: Math.floor(Date.now() / 1000) + 3600,
        miltonBinding: "binding",
        miltonIdentityIncarnation: "f:1",
        miltonSecurityGeneration: "f:2",
      });
    throw new Error("Unexpected protocol endpoint");
  };
  return { state, transport };
}
