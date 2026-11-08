/** Owner-only: provisions the fictional account the daily end-to-end check uses.
 * Creates the native user with a verified `.invalid` email and a random password
 * (nothing is mailed), creates its Milton account marked test_account with no
 * trial row (so no sign-in, checkout or backfill ever calls Stripe for it), signs
 * in over HTTPS as a browser does, mints a read-and-save connection key through
 * the app's own form, and writes the three values to a new mode-0600 env file.
 * Prints one JSON line per step and never a password, key, cookie or URL. */
import { access, open } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  createVerifiedUser,
  fictionalEmail,
} from "../../apps/auth/scripts/test-user.ts";
import { databaseOptions } from "../../apps/auth/src/database.ts";
import { validateDatabaseUrl } from "../src/store/database";

export const TEST_EMAIL = "e2e@milton-test.invalid";
export const PRODUCTION = {
  app: "https://app.meetmilton.com",
  auth: "https://auth.meetmilton.com",
  mcp: "https://mcp.meetmilton.com/mcp",
};
export type Origins = typeof PRODUCTION;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** Every request gives up after this long; one slow hop fails its step. */
export const REQUEST_MS = 15_000;
/** The key the check uses: read and save, the longest finite expiry. */
export const KEY_DAYS = 365;

export class CheckError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function fail(code: string): never {
  throw new CheckError(code);
}

const entities: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&lt;": "<",
  "&gt;": ">",
};
/** An HTML attribute value as escaped by Hono JSX, unescaped. */
export const unescape = (value: string) =>
  value.replace(/&(amp|quot|#39|#x27|lt|gt);/g, (e) => entities[e]!);

/** A cookie jar per host and manual redirects, as a browser keeps host-only
 * Secure cookies. Only the given origins are ever requested. */
export function browser(origins: Origins, fetcher: Fetch = fetch) {
  const allowed = new Set([origins.app, origins.auth]);
  const jars = new Map<string, Map<string, string>>();
  async function go(url: string, form?: Record<string, string>) {
    const u = new URL(url);
    if (!allowed.has(u.origin)) fail("unexpected_origin");
    const jar = jars.get(u.host) ?? new Map<string, string>();
    jars.set(u.host, jar);
    const headers = new Headers({
      Accept: "text/html",
      "Sec-Fetch-Mode": "navigate",
    });
    if (jar.size)
      headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (form) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      headers.set("Origin", u.origin);
      headers.set("Sec-Fetch-Site", "same-origin");
    }
    const response = await fetcher(u.href, {
      method: form ? "POST" : "GET",
      headers,
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const i = pair.indexOf("=");
      if (i < 1) continue;
      const name = pair.slice(0, i),
        value = pair.slice(i + 1);
      if (/;\s*Max-Age=0/i.test(cookie) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  }
  /** Follows redirects and native's Continue pages (meta refresh) to a page. */
  async function follow(url: string, form?: Record<string, string>) {
    let current = url;
    let response = await go(current, form);
    for (let hop = 0; hop < 12; hop++) {
      const location = response.headers.get("Location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current).href;
        response = await go(current);
        continue;
      }
      const html = await response.text();
      const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)"/.exec(
        html,
      );
      if (response.status === 200 && refresh) {
        current = new URL(unescape(refresh[1]!), current).href;
        response = await go(current);
        continue;
      }
      return { status: response.status, url: new URL(current), html };
    }
    return fail("too_many_redirects");
  }
  return { go, follow };
}
export type Browser = ReturnType<typeof browser>;

/** Signs in with email and password exactly as a browser does: app /login, the
 * native sign-in page, its form, then the app's code flow back to the report.
 * Returns the signed-in page, which must name this account. */
export async function signIn(
  b: Browser,
  origins: Origins,
  email: string,
  password: string,
) {
  const login = await b.follow(origins.app + "/login");
  if (
    login.status !== 200 ||
    login.url.origin !== origins.auth ||
    login.url.pathname !== "/login"
  )
    fail("sign_in_page_unavailable");
  const at = login.html.indexOf('action="/form/signin"');
  const query = /name="oauth_query" value="([^"]*)"/.exec(
    login.html.slice(Math.max(at, 0)),
  );
  if (at < 0 || !query) fail("sign_in_form_unavailable");
  const home = await b.follow(origins.auth + "/form/signin", {
    oauth_query: unescape(query[1]!),
    email,
    password,
  });
  if (
    home.status !== 200 ||
    home.url.origin !== origins.app ||
    home.url.pathname !== "/"
  )
    fail("sign_in_refused");
  if (!home.html.includes(`Signed in as <strong>${email}</strong>`))
    fail("signed_in_account_mismatch");
  return home;
}

const csrfOf = (html: string) =>
  /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1] ??
  fail("csrf_unavailable");
export const KEY_PATTERN = /mk_([A-Za-z0-9_-]{22})_[A-Za-z0-9_-]{43}/;

/** Mints a read-and-save key through the app's own form, from the fresh session
 * signIn just made; the app binds it to that session's native authority. */
export async function mintKey(b: Browser, origins: Origins, name: string) {
  const page = await b.follow(origins.app + "/assistants");
  if (page.status !== 200) fail("assistants_page_unavailable");
  const created = await b.go(origins.app + "/assistants/keys", {
    csrf: csrfOf(page.html),
    name,
    scope: "read_write",
    expiry: String(KEY_DAYS),
  });
  const html = await created.text();
  if (created.status !== 200) fail("key_refused");
  return KEY_PATTERN.exec(html)?.[0] ?? fail("key_missing");
}

/** Owner connections. Native: `milton_auth_owner` through its delegated login
 * (AUTH_OWNER_DATABASE_URL, `options=-c role=milton_auth_owner`). Writing: the
 * owner of public.users (MILTON_OWNER_DATABASE_URL, the db:migrate connection). */
export type Owners = { native: pg.Pool; writing: pg.Pool };
export function ownerPools(nativeUrl: string, writingUrl: string): Owners {
  return {
    native: new pg.Pool({
      ...databaseOptions(nativeUrl),
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    }),
    writing: new pg.Pool({
      connectionString: validateDatabaseUrl(writingUrl),
      ssl: true,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    }),
  };
}

type Step = (step: string, ok: boolean, ms: number, extra?: object) => void;
const line: Step = (step, ok, ms, extra = {}) =>
  console.log(JSON.stringify({ step, ok, ms, ...extra }));

export async function provisionTestAccount(options: {
  email: string;
  output: string;
  owners: Owners;
  origins?: Origins;
  fetch?: Fetch;
  report?: Step;
}) {
  const { email, owners } = options;
  const origins = options.origins ?? PRODUCTION;
  const issuer = origins.auth + "/api/auth";
  const report = options.report ?? line;
  const output = resolve(options.output);
  let step = "refusals";
  let started = Date.now();
  const done = (extra?: object) => {
    report(step, true, Date.now() - started, extra);
    started = Date.now();
  };
  try {
    // Every refusal comes before any write.
    if (!fictionalEmail(email)) fail("test_email_must_end_invalid");
    const repo = resolve(new URL("../../", import.meta.url).pathname);
    if (output.startsWith(repo + "/")) fail("output_inside_repository");
    if (
      await access(output).then(
        () => true,
        () => false,
      )
    )
      fail("output_exists");
    const native = await owners.native.query<{ role: string; taken: boolean }>(
      `select current_user as role, exists(select 1 from milton_auth."user" where lower(email)=lower($1)) as taken`,
      [email],
    );
    if (native.rows[0]?.role !== "milton_auth_owner")
      fail("native_owner_required");
    if (native.rows[0]?.taken) fail("test_email_exists");
    const writing = await owners.writing.query<{
      owner: boolean;
      migrated: boolean;
    }>(
      `select current_database()='milton' and current_user=(select relowner::regrole::text from pg_class where oid='public.users'::regclass) as owner,
        exists(select 1 from information_schema.columns where table_schema='public' and table_name='users' and column_name='test_account') as migrated`,
    );
    if (!writing.rows[0]?.owner) fail("writing_owner_required");
    if (!writing.rows[0]?.migrated) fail("migration_0009_required");
    done();

    // The password is generated here and reaches only the file and the sign-in
    // form. Writing it first means a later failure never strands the account.
    step = "secrets_file";
    const password = randomBytes(24).toString("base64url");
    const file = await open(output, "wx", 0o600);
    try {
      await file.writeFile(`E2E_EMAIL=${email}\nE2E_PASSWORD=${password}\n`);
    } finally {
      await file.close();
    }
    done();

    step = "native_user";
    const subject = await createVerifiedUser(owners.native, email, password);
    done();

    // The Milton account exists before the first sign-in, marked and without a
    // trial row: admission finds it, and with no trial row no Stripe call
    // happens at sign-in, checkout (409) or backfill (skipped).
    step = "milton_account";
    const userId = `m_${randomUUID()}`;
    const client = await owners.writing.connect();
    try {
      await client.query("begin");
      await client.query("insert into users(id,test_account) values($1,true)", [
        userId,
      ]);
      await client.query(
        "insert into identities(provider,subject,user_id) values($1,$2,$3)",
        [issuer, subject, userId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    done();

    step = "sign_in";
    const b = browser(origins, options.fetch);
    await signIn(b, origins, email, password);
    done();

    step = "connection_key";
    const key = await mintKey(b, origins, "Daily e2e check");
    done();

    step = "verify";
    const state = await owners.writing.query<{
      id: string;
      marked: boolean;
      active: boolean;
      trial: boolean;
      scope: string;
      days: number;
    }>(
      `select u.id, u.test_account as marked, u.status='active' as active,
        exists(select 1 from trial_accounts t where t.user_id=u.id) as trial,
        k.scope, round(extract(epoch from k.expires_at-now())/86400)::int as days
       from identities i join users u on u.id=i.user_id
       join connection_keys k on k.user_id=u.id and k.id=$3
       where i.provider=$1 and i.subject=$2`,
      [issuer, subject, KEY_PATTERN.exec(key)![1]],
    );
    const row = state.rows[0];
    if (
      !row ||
      state.rows.length !== 1 ||
      row.id !== userId ||
      !row.marked ||
      !row.active ||
      row.trial ||
      row.scope !== "read_write" ||
      Math.abs(row.days - KEY_DAYS) > 1
    )
      fail("account_state_unexpected");
    const append = await open(output, "a");
    try {
      await append.writeFile(`E2E_CONNECTION_KEY=${key}\n`);
    } finally {
      await append.close();
    }
    done({ key_days: row.days });
    return { userId, subject };
  } catch (error) {
    report(step, false, Date.now() - started, {
      error: error instanceof CheckError ? error.code : "unexpected",
    });
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const email = args.includes("--email")
    ? args[args.indexOf("--email") + 1]
    : TEST_EMAIL;
  const output = args.at(-1);
  const nativeUrl = process.env.AUTH_OWNER_DATABASE_URL;
  const writingUrl = process.env.MILTON_OWNER_DATABASE_URL;
  if (
    args[0] !== "--apply" ||
    !email ||
    !output ||
    output.startsWith("--") ||
    !nativeUrl ||
    !writingUrl
  ) {
    console.error(`Usage:
  bun --no-env-file server/scripts/test-account.ts --apply [--email <addr@x.invalid>] <new env file>

Owner-only. Needs AUTH_OWNER_DATABASE_URL (the milton_auth_delegate login assuming
milton_auth_owner) and MILTON_OWNER_DATABASE_URL (the writing owner, as db:migrate).
Writes E2E_EMAIL, E2E_PASSWORD and E2E_CONNECTION_KEY to the new file, mode 0600,
and refuses a file that exists, an email native holds or one outside .invalid.`);
    process.exit(2);
  }
  const owners = ownerPools(nativeUrl, writingUrl);
  try {
    await provisionTestAccount({ email, output, owners });
  } catch {
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([owners.native.end(), owners.writing.end()]);
  }
}
