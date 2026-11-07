/** @jsxImportSource hono/jsx */
import { AuthError } from "./token";
import { isLoopback } from "./config";
import { faviconLinks, folderMark } from "@milton/theme/brand";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { TrialStatus } from "./store/trials";

/**
 * The signed-in account chrome: the header's account menu and the links row.
 * The email shows only here, never on public pages or in downloads. "Switch
 * account" signs out to the sign-in page; signing out never disconnects
 * assistants.
 */
export type Account = {
  csrf: () => Child;
  email?: string;
  /** The current page in the links row, if it is one of them. */
  here?: "report" | "assistants";
  billing?: BillingItem;
};
export type BillingItem = { action: "checkout" | "portal"; label: string };

/** The one billing action a status offers. Early access has none. */
export function billingItem(status?: TrialStatus): BillingItem | undefined {
  if (status?.status === "trial")
    return { action: "checkout", label: "Add a card" };
  if (status?.status === "expired")
    return { action: "checkout", label: "Subscribe" };
  if (status?.status === "paid")
    return { action: "portal", label: "Manage billing" };
}
const links = [
  ["report", "/", "Cover sheet"],
  ["assistants", "/assistants", "Connected assistants"],
  [null, "/download", "Download TPS.md"],
] as const;
function accountMenu({ csrf, email, billing }: Account) {
  // Native popover dismissal and focus handling keep these pages script-free.
  return (
    <div class="header-actions">
      <a class="button header-cta" href="/assistants">
        Connect an assistant
      </a>
      <button
        type="button"
        class="account-menu secondary"
        popovertarget="account-panel"
      >
        Account
        <span aria-hidden="true">▾</span>
      </button>
      <div class="menu-panel" id="account-panel" popover="auto">
        {email && (
          <p class="small-note menu-who">
            Signed in as <strong>{email}</strong>
          </p>
        )}
        {billing && (
          <form method="post" action={`/billing/${billing.action}`}>
            {csrf()}
            <button class="menu-item">{billing.label}</button>
          </form>
        )}
        <form method="post" action="/logout">
          {csrf()}
          <button
            class="menu-item"
            name="next"
            value="login"
            aria-describedby="signout-note"
          >
            Switch account
          </button>
          <button class="menu-item" aria-describedby="signout-note">
            Sign out
          </button>
        </form>
        <p class="small-note" id="signout-note">
          Signing out of this browser does not disconnect your assistants.
        </p>
        <a class="menu-item" href="/account/security">
          Sign-in and security
        </a>
        <a class="menu-item danger" href="/account/delete">
          Delete account
        </a>
      </div>
    </div>
  );
}

/**
 * One shell for every page. A sheet page (the cover sheet) brings its own
 * title; every other page gets an h1 and a readable-width body.
 */
export function page(
  title: string,
  content: Child,
  status = 200,
  head: Child = null,
  { account, sheet = false }: { account?: Account; sheet?: boolean } = {},
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
        <div class="app-shell">
          <header class="app-header">
            <a class="brand" href="/" aria-label="Milton home">
              {raw(folderMark)}
              <span>Milton</span>
            </a>
            {account && accountMenu(account)}
          </header>
          <main id="main" tabindex={-1}>
            {account && (
              <nav aria-label="Account">
                {links.map(([id, href, label]) => (
                  <a
                    href={href}
                    aria-current={
                      id && id === account.here ? "page" : undefined
                    }
                  >
                    {label}
                  </a>
                ))}
              </nav>
            )}
            {sheet ? (
              content
            ) : (
              <div class="page-body">
                <h1>{title}</h1>
                {content}
              </div>
            )}
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
/** The unexpected-error page for browser page requests: nothing changed, no
 * link or button. Every other request keeps onError's JSON. */
export function unavailablePage() {
  return page(
    "PC LOAD LETTER",
    <p>
      Something went wrong on our side. Your cover sheet and reports are
      unchanged. Try again in a moment.
    </p>,
    503,
  );
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
      <p>Taking you to the next page.</p>
      <p>
        <a href={url.href}>Continue</a>
      </p>
    </>,
    200,
    <meta http-equiv="refresh" content={`0;url=${url.href}`} />,
  );
}
