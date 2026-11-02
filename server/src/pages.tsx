/** @jsxImportSource hono/jsx */
import { AuthError } from "./token";
import { isLoopback } from "./config";
import { faviconLinks, folderMark } from "@milton/theme/brand";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";

export function page(
  title: string,
  content: Child,
  status = 200,
  head: Child = null,
  layout: "narrow" | "memo" | "tps" = "narrow",
) {
  const document = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title} · Milton</title>
        {raw(faviconLinks)}
        <link rel="stylesheet" href="/milton.css" />
        {head}
      </head>
      <body>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <div class={`app-shell ${layout}`}>
          <header class="app-header">
            <a class="brand" href="/" aria-label="Milton home">
              {raw(folderMark)}
              <span>Milton</span>
            </a>
          </header>
          <main id="main" tabindex={-1}>
            {layout !== "tps" && <h1>{title}</h1>}
            {content}
          </main>
        </div>
      </body>
    </html>
  );
  // Only the two source-controlled theme fragments above bypass JSX escaping.
  return new Response("<!doctype html>" + document.toString(), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export function navigation(target: string) {
  let url: URL;
  try {
    url = new URL(target);
    if (
      url.username ||
      url.password ||
      /[\r\n]/.test(target) ||
      ["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(
        url.protocol,
      ) ||
      (url.protocol === "http:" && !isLoopback(url.hostname))
    )
      throw new Error();
  } catch {
    throw new AuthError(
      "auth_unavailable",
      "The sign-in destination is unavailable. Restart from your assistant.",
      503,
    );
  }
  // A new document navigates after POST. No external Location redirect follows
  // a form restricted by form-action 'self' (Chromium/Safari handle that differently).
  return page(
    "Continue",
    <>
      <p>Continuing your sign-in.</p>
      <p>
        <a href={url.href}>Continue</a>
      </p>
    </>,
    200,
    <meta http-equiv="refresh" content={`0;url=${url.href}`} />,
  );
}
