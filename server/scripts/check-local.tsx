/** @jsxImportSource hono/jsx */
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { page } from "../src/pages";
import { checkMcp } from "./check-mcp";
import { localAsset } from "./assets";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { origin: { type: "string", default: "http://localhost:3001" } },
});
const target = new URL(values.origin!);
if (
  !["http:", "https:"].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.search ||
  target.hash ||
  target.pathname !== "/"
)
  throw new Error("Pass an origin without credentials, query or path.");
let authorization: URL | undefined;
let information: OAuthClientInformationMixed | undefined;
let tokens: OAuthTokens | undefined;
let verifier = "";
const state = crypto.randomUUID();
let acceptCode: (code: string) => void;
let rejectCode: (error: Error) => void;
const callbackCode = new Promise<string>((resolve, reject) => {
  acceptCode = resolve;
  rejectCode = reject;
});
const browser = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      request.headers.get("Host") !== new URL(browser.url).host
    )
      return new Response(null, { status: 403 });
    if (url.pathname === "/callback") {
      if (url.searchParams.get("state") !== state)
        return new Response("Invalid callback state.", { status: 400 });
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        rejectCode(new Error("Authorization was refused."));
        return page("Connection refused", <p>Return to the terminal.</p>, 403);
      }
      acceptCode(code);
      return page(
        "Connected",
        <p>Return to the terminal for the check result.</p>,
      );
    }
    const asset = localAsset(request);
    if (asset) return asset;
    return authorization
      ? page(
          "Connect the local check",
          <p>
            <a href={authorization.href}>Sign in to Milton</a>
          </p>,
        )
      : page(
          "Preparing connection",
          <p>Reload this page when the terminal is ready.</p>,
        );
  },
});
const callback = new URL("/callback", browser.url).href;
const authProvider: OAuthClientProvider = {
  redirectUrl: callback,
  clientMetadata: {
    client_name: "Milton local check",
    redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "openid offline_access",
  },
  state: () => state,
  clientInformation: () => information,
  saveClientInformation: (value) => {
    information = value;
  },
  tokens: () => tokens,
  saveTokens: (value) => {
    tokens = value;
  },
  redirectToAuthorization: (value) => {
    authorization = value;
  },
  saveCodeVerifier: (value) => {
    verifier = value;
  },
  codeVerifier: () => verifier,
};
const client = new Client({ name: "milton-local-check", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("/mcp", target), {
  authProvider,
});
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !authorization) throw error;
    console.log(
      `Open ${browser.url.origin}/ to sign in. OAuth credentials stay in memory.`,
    );
    timer = setTimeout(
      () => rejectCode(new Error("Sign-in timed out.")),
      300000,
    );
    await transport.finishAuth(await callbackCode);
    // A started transport cannot be restarted; reconnect with the saved tokens.
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", target), {
        authProvider,
      }),
    );
  }
  console.log(await checkMcp(client));
} catch {
  console.error(
    "The local OAuth client check failed. Restart the connection and check server configuration.",
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close();
  browser.stop(true);
}
