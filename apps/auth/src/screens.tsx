/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

export function Page({
  title,
  children,
  notice,
  refresh,
}: {
  title: string;
  children: Child;
  notice?: string;
  refresh?: string;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="strict-origin" />
        {refresh ? (
          <meta http-equiv="refresh" content={`0;url=${refresh}`} />
        ) : null}
        <title>{title} · Milton</title>
        <link rel="icon" href="/favicon.svg" />
        <link rel="stylesheet" href="/auth.css" />
      </head>
      <body>
        <header>
          <a href="/login" aria-label="Milton home">
            Milton<span>YOUR WRITING, KEPT.</span>
          </a>
          <a href="https://app.meetmilton.com/">Back to Milton</a>
        </header>
        <main>
          <div class="sheet">
            <p class="eyebrow">MILTON / YOUR ACCOUNT</p>
            <h1>{title}</h1>
            {notice ? (
              <p role="status" class="notice">
                {notice}
              </p>
            ) : null}
            {children}
          </div>
          <footer>
            <a href="https://meetmilton.com/privacy">Privacy</a>
            <a href="/security">Account security</a>
          </footer>
        </main>
      </body>
    </html>
  );
}
export function Input({
  name,
  label,
  type = "text",
  autocomplete,
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  autocomplete?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type={type}
        autocomplete={autocomplete}
        required={required}
        maxlength={type === "password" ? 256 : 320}
      />
    </label>
  );
}
export function SignIn({
  signup = false,
  query = "",
}: {
  signup?: boolean;
  query?: string;
}) {
  return (
    <>
      <p>
        {signup
          ? "Create your Milton sign-in. Verify your email before connecting an assistant."
          : "Sign in to open your writing or connect an assistant."}
      </p>
      <div class="social">
        {["google", "github"].map((provider) => (
          <form method="post" action="/form/social">
            <input type="hidden" name="provider" value={provider} />
            <input type="hidden" name="oauth_query" value={query} />
            <button class="secondary" type="submit">
              Continue with {provider === "google" ? "Google" : "GitHub"}
            </button>
          </form>
        ))}
      </div>
      <p class="divider">Or use your email</p>
      <form method="post" action={signup ? "/form/signup" : "/form/signin"}>
        <input type="hidden" name="oauth_query" value={query} />
        {signup ? <Input name="name" label="Name" autocomplete="name" /> : null}
        <Input
          name="email"
          label="Email"
          type="email"
          autocomplete="username"
        />
        <Input
          name="password"
          label="Password"
          type="password"
          autocomplete={signup ? "new-password" : "current-password"}
        />
        {signup ? (
          <p class="hint" id="password-policy">
            Use 15–128 Unicode characters. Spaces are welcome. Common passwords
            are refused. Equivalent Unicode forms share a password.
          </p>
        ) : null}
        <button type="submit">{signup ? "Create account" : "Sign in"}</button>
      </form>
      <nav>
        <a href={(signup ? "/login" : "/signup") + (query ? "?" + query : "")}>
          {signup ? "Already have an account? Sign in" : "Create an account"}
        </a>
        <a href="/forgot-password">Forgot password?</a>
        <a href="/verify">Resend verification email</a>
      </nav>
    </>
  );
}
export function EmailForm({ reset = false }: { reset?: boolean }) {
  return (
    <>
      <p>
        {reset
          ? "We’ll email a link to set a password. This also works if you first signed in with Google or GitHub."
          : "Check your email for a verification link. You can request another below."}
      </p>
      <form method="post" action={reset ? "/form/forgot" : "/form/verify"}>
        <Input name="email" label="Email" type="email" autocomplete="email" />
        <button type="submit">
          Send {reset ? "reset" : "verification"} email
        </button>
      </form>
      <p>
        <a href="/login">Return to sign in</a>
      </p>
    </>
  );
}
export function ResetForm({ token }: { token: string }) {
  return (
    <>
      <p>
        Set a new password. This ends existing browser sessions and assistant
        connections. Reconnect assistants after signing in again.
      </p>
      <form method="post" action="/form/reset">
        <input type="hidden" name="token" value={token} />
        <Input
          name="newPassword"
          label="New password"
          type="password"
          autocomplete="new-password"
        />
        <p class="hint">
          Use 15–128 Unicode characters. Spaces are preserved; equivalent
          Unicode forms share a password.
        </p>
        <button type="submit">Set password</button>
      </form>
      <p>
        <a href="/forgot-password">Expired link? Request another</a>
      </p>
    </>
  );
}
export function Consent({ query }: { query: URLSearchParams }) {
  const requested = (query.get("scope") ?? "").split(" ");
  const canWrite = requested.includes("milton:write");
  if (!requested.includes("milton:read"))
    return (
      <p>
        This assistant request is missing reading permission. Start a new
        connection from your assistant.
      </p>
    );
  const read = requested.filter((s) => s !== "milton:write").join(" ");
  return (
    <>
      <p>
        The assistant{" "}
        <strong class="identifier">
          {query.get("client_id") ?? "Unknown client"}
        </strong>{" "}
        is asking to connect to your writing. Check that this is the assistant
        you intended.
      </p>
      <form method="post" action="/form/consent">
        <input type="hidden" name="oauth_query" value={query.toString()} />
        <fieldset>
          <legend>Choose permission</legend>
          <label class="choice">
            <input type="radio" name="scope" value={read} checked />
            Read only
            <span>Read your cover sheet and reports with three tools.</span>
          </label>
          {canWrite ? (
            <label class="choice">
              <input type="radio" name="scope" value={requested.join(" ")} />
              Read and write
              <span>
                Also save exact memos you approve with create_memo. Four tools.
              </span>
            </label>
          ) : null}
        </fieldset>
        {requested.some((s) => s === "email" || s === "profile") ? (
          <p>
            This request also includes{" "}
            {requested
              .filter((s) => s === "email" || s === "profile")
              .join(" and ")}{" "}
            identity information.
          </p>
        ) : null}
        <p>
          Writing permission lets an assistant use the save tool. You still
          approve the exact text of every memo. You can disconnect an assistant
          in Milton.
        </p>
        <div class="actions">
          <button name="accept" value="true" type="submit">
            Allow connection
          </button>
          <button name="accept" value="false" type="submit" class="secondary">
            Deny
          </button>
        </div>
      </form>
      <p class="hint">
        Expired or interrupted request? Start the connection again from your
        assistant.
      </p>
    </>
  );
}
export type SessionSummary = {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};
export type MethodSummary = { id: string; providerId: string };
export function Security({
  email,
  fresh,
  methods,
  sessions,
}: {
  email: string;
  fresh: boolean;
  methods: MethodSummary[];
  sessions: SessionSummary[];
}) {
  return (
    <>
      <p>
        Signed in as <strong class="identifier">{email}</strong>.
      </p>
      {!fresh ? (
        <p class="notice">
          Sign in again before changing sign-in methods or sessions.{" "}
          <a href="/login">Sign in</a>
        </p>
      ) : null}
      <h2>Sign-in methods</h2>
      <ul class="records">
        {methods.map((method) => (
          <li>
            <span>
              {method.providerId === "credential"
                ? "Email and password"
                : method.providerId === "google"
                  ? "Google"
                  : "GitHub"}
            </span>
            <form method="post" action="/form/unlink">
              <input type="hidden" name="accountId" value={method.id} />
              <button class="secondary" disabled={!fresh || methods.length < 2}>
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>
      <p>
        Removing a method requires another working method, ends browser sessions
        and disconnects assistants. Your writing stays with this account.
      </p>
      <div class="actions">
        {["google", "github"]
          .filter((provider) => !methods.some((m) => m.providerId === provider))
          .map((provider) => (
            <form method="post" action="/form/link">
              <input type="hidden" name="provider" value={provider} />
              <button class="secondary" disabled={!fresh}>
                Link {provider === "google" ? "Google" : "GitHub"}
              </button>
            </form>
          ))}
      </div>
      {methods.some((m) => m.providerId === "credential") ? (
        <>
          <h2>Change password</h2>
          <form method="post" action="/form/change">
            <Input
              name="currentPassword"
              label="Current password"
              type="password"
              autocomplete="current-password"
            />
            <Input
              name="newPassword"
              label="New password"
              type="password"
              autocomplete="new-password"
            />
            <p class="hint">
              15–128 Unicode characters. Other sessions and all assistant
              connections end.
            </p>
            <button disabled={!fresh}>Change password</button>
          </form>
        </>
      ) : (
        <p>
          <a href="/forgot-password">Add your first password by email</a>
        </p>
      )}
      <h2>Browser sessions</h2>
      <ul class="records">
        {sessions.map((session) => (
          <li>
            <div>
              <strong>
                {session.current ? "This session" : "Other session"}
              </strong>
              <p>
                Signed in{" "}
                {new Date(session.createdAt).toISOString().slice(0, 10)}
              </p>
            </div>
            <form method="post" action="/form/revoke">
              <input type="hidden" name="sessionId" value={session.id} />
              <button class="secondary" disabled={!fresh}>
                End session
              </button>
            </form>
          </li>
        ))}
      </ul>
      <form method="post" action="/form/revoke-others">
        <button class="secondary" disabled={!fresh}>
          End other sessions
        </button>
      </form>
      <p>
        Ending browser sessions leaves offline assistants connected. Manage
        assistant connections and account deletion in{" "}
        <a href="https://app.meetmilton.com/account">Milton</a>.
      </p>
      <form method="post" action="/form/signout">
        <button class="secondary">Sign out</button>
      </form>
    </>
  );
}
