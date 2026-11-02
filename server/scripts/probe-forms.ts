// Checks that a signed-out browser form post passes the CSRF check on the app
// host: GET /login for a CSRF token, then POST /assistants/disconnect the way
// Chrome does under Referrer-Policy: no-referrer (Origin: null). Signed out, a
// passing check reaches the sign-in requirement. Never prints the token.
// Usage: bun scripts/probe-forms.ts https://app.example
const base = process.argv[2];
if (!base || !/^https?:\/\/[^/?#@]+\/?$/.test(base)) {
  console.error("Usage: bun scripts/probe-forms.ts <app origin>");
  process.exit(2);
}
const app = new URL(base).origin;

const login = await fetch(app + "/login", { redirect: "manual" });
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0]!)
  .find((pair) => /^(__Host-)?milton-csrf=/.test(pair));
const field = /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(
  await login.text(),
)?.[1];
if (!cookie || !field) {
  console.error(
    `UNEXPECTED: GET /login (${login.status}) issued no CSRF token`,
  );
  process.exit(1);
}

const post = await fetch(app + "/assistants/disconnect", {
  method: "POST",
  redirect: "manual",
  headers: {
    Origin: "null",
    "Sec-Fetch-Site": "same-origin",
    Cookie: cookie,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ csrf: field }),
});
const body = await post.text();
if (body.includes("Sign in to Milton before continuing.")) {
  console.log(`PASS: form post reached the sign-in check (${post.status})`);
  process.exit(0);
}
if (body.includes("Reload the page")) {
  console.error(`FAIL: form post refused as csrf_refused (${post.status})`);
  process.exit(1);
}
console.error(`UNEXPECTED: form post answered ${post.status}`);
process.exit(1);

export {};
