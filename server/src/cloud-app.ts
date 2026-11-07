import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { RuntimeConfig } from "./config";
import { createMiltonApp } from "./index";
import { loadAssets, localAsset } from "./assets";

export function createCloudApp(config: RuntimeConfig) {
  const app = createMiltonApp(config, true);
  loadAssets();
  return async (request: Request): Promise<Response> => {
    const refusal = hostHeaderValidationResponse(request, [
      new URL(config.appOrigin).hostname,
    ]);
    if (refusal) return refusal;
    // TLS ends at Google's front end, so Node sees http:. Once the Host is
    // canonical, the request URL is the configured origin, never a proxy header.
    const url = new URL(request.url);
    // Node requires duplex for a streamed body; the DOM RequestInit type omits it.
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      duplex: "half",
    };
    const canonical = new Request(
      config.appOrigin + url.pathname + url.search,
      init,
    );
    return localAsset(canonical) ?? app(canonical);
  };
}
