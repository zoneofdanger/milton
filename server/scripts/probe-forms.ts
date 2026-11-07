// Checks a signed-out same-origin double-submit form under no-referrer policy.
// It uses a fresh fictional CSRF value, never signs in or follows an auth flow,
// and prints no cookie. Running against hosting is a separately selected action.
import { randomBytes } from "node:crypto";
const base = process.argv[2];
if (!base || !/^https?:\/\/[^/?#@]+\/?$/.test(base)) {
  console.error("Usage: bun scripts/probe-forms.ts <app origin>");
  process.exit(2);
}
const app = new URL(base).origin;

const field = randomBytes(32).toString("base64url");
const cookie =
  (new URL(app).protocol === "https:" ? "__Host-" : "") +
  "milton-csrf=" +
  field;

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
