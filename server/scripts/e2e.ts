/** The daily end-to-end check, safe against production because it touches only
 * the fictional test account (test-account.ts). It signs in as a browser does,
 * connects to MCP with the account's connection key, refuses to write unless the
 * account holds nothing but this check's own marked leftovers, then saves, reads
 * fresh, revises, retires and confirms the account is back where the run began.
 * One JSON line per step on stdout (`step`, `ok`, `ms`, `severity`), never a
 * password, key, cookie or sample body. Exit 0 only when every step passed. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fictionalEmail } from "../../apps/auth/scripts/test-user.ts";
import {
  browser,
  CheckError,
  fail,
  KEY_PATTERN,
  PRODUCTION,
  REQUEST_MS,
  signIn,
  type Fetch,
  type Origins,
} from "./test-account";

/** Every sample this check writes carries the marker in its context summary and
 * files under this kind, so a crashed run's leftovers are recognized. */
export const MARKER = "Milton e2e check";
export const KIND = "e2e check";
const REPORT = "document";
const INTENT = { situation: "confirming what is on file" };
/** The check warns, without failing, when the key has fewer days left. */
export const KEY_WARN_DAYS = 30;
/** A report serves eight samples; at eight the rest cannot be seen. */
const SERVED = 8;
const TOOLS = ["create_memo", "get_cover_sheet", "get_report", "list_reports"];

type Severity = "INFO" | "WARNING" | "ERROR";
export type Line = {
  step: string;
  ok: boolean;
  ms: number;
  severity: Severity;
  [extra: string]: unknown;
};
const print = (line: Line) => console.log(JSON.stringify(line));

export async function readSecrets(path: string) {
  const values = new Map<string, string>();
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const match = /^(E2E_[A-Z_]+)=(.+)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  const email = values.get("E2E_EMAIL") ?? "";
  const password = values.get("E2E_PASSWORD") ?? "";
  const key = values.get("E2E_CONNECTION_KEY") ?? "";
  if (!fictionalEmail(email)) fail("test_email_must_end_invalid");
  if (!password) fail("password_missing");
  const parsed = new RegExp(`^${KEY_PATTERN.source}$`).exec(key);
  if (!parsed) fail("connection_key_missing");
  return { email, password, key, keyId: parsed[1]! };
}

type Report = {
  report_id: string;
  text: string;
  samples: {
    id: string;
    kind_id: string;
    kind: string;
    context: { version: 1; summary: string };
    revision: number;
  }[];
};

/** One MCP connection with the key: initialize, then calls, each bounded. */
async function mcpSession(origins: Origins, key: string, fetcher: Fetch) {
  const client = new Client({ name: "milton-e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origins.mcp), {
      fetch: (input, init) =>
        fetcher(String(input), {
          ...init,
          redirect: "manual",
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_MS)])
            : AbortSignal.timeout(REQUEST_MS),
        }),
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
    { timeout: REQUEST_MS },
  );
  const call = async <T>(name: string, args: object = {}): Promise<T> => {
    const reply = await client.callTool(
      { name, arguments: args as Record<string, unknown> },
      undefined,
      { timeout: REQUEST_MS },
    );
    const text = (reply.content as { type: string; text?: string }[])?.[0]
      ?.text;
    let value: Record<string, unknown> = {};
    try {
      value = JSON.parse(text ?? "{}");
    } catch {
      fail(`${name}_unreadable`);
    }
    if (reply.isError)
      fail(
        `${name}_${typeof value.error === "string" ? value.error : "error"}`,
      );
    return value as T;
  };
  return {
    tools: async () =>
      (await client.listTools(undefined, { timeout: REQUEST_MS })).tools
        .map((t) => t.name)
        .sort(),
    cover: () =>
      call<{ text: string; version: string; is_empty: boolean }>(
        "get_cover_sheet",
      ),
    reports: () => call<{ reports: Report[]; version: string }>("list_reports"),
    report: () =>
      call<Report & { version: string }>("get_report", {
        report_id: REPORT,
        intent: INTENT,
      }),
    save: async (args: object) => {
      const outcome = await call<{
        status: string;
        version?: string;
        samples_retired?: { id: string }[];
      }>("create_memo", { request_id: randomUUID(), ...args });
      if (outcome.status !== "saved") fail(`create_memo_${outcome.status}`);
      return outcome;
    },
    close: () => client.close(),
  };
}
type Session = Awaited<ReturnType<typeof mcpSession>>;

const leftover = (s: Report["samples"][number]) =>
  s.kind === KIND && s.context.summary.startsWith(MARKER + ", run ");
/** A report body is its heading, its when line, one paragraph per served sample
 * (each starts "Approved, ") and then one bullet per rule. */
const holdsRules = (r: Report) =>
  r.text
    .split("\n\n")
    .slice(2)
    .some((p) => !p.startsWith("Approved, "));
const quoted = (body: string) => body.replace(/^/gm, "> ");

export async function runE2E(options: {
  secrets: string;
  origins?: Origins;
  fetch?: Fetch;
  report?: (line: Line) => void;
}) {
  const origins = options.origins ?? PRODUCTION;
  const fetcher = options.fetch ?? fetch;
  const report = options.report ?? print;
  const run = randomUUID().slice(0, 8);
  const begun = Date.now();
  let started = begun;
  let step = "secrets";
  const done = (extra: object = {}, severity: Severity = "INFO") => {
    report({ step, ok: true, ms: Date.now() - started, severity, ...extra });
    started = Date.now();
  };
  let secrets: Awaited<ReturnType<typeof readSecrets>>;
  const sessions: Session[] = [];
  const session = async () => {
    const s = await mcpSession(origins, secrets.key, fetcher);
    sessions.push(s);
    return s;
  };
  try {
    secrets = await readSecrets(options.secrets);
    done();

    step = "sign_in";
    const b = browser(origins, fetcher);
    await signIn(b, origins, secrets.email, secrets.password);
    done();

    step = "mcp_connect";
    const first = await session();
    if ((await first.tools()).join() !== TOOLS.join()) fail("tools_unexpected");
    done({ tools: TOOLS.length });

    // Nothing is written until the account is known to be the test account,
    // this key is its own and it holds only this check's marked leftovers.
    step = "safety_gate";
    const assistants = await b.follow(origins.app + "/assistants");
    if (
      assistants.status !== 200 ||
      !assistants.html.includes(
        `Signed in as <strong>${secrets.email}</strong>`,
      )
    )
      fail("signed_in_account_mismatch");
    const item = assistants.html
      .split("<li>")
      .find((li) =>
        li.includes(`/assistants/keys/revoke?key=${secrets.keyId}"`),
      );
    if (!item) fail("key_not_on_account");
    const expires = /Expires <time datetime="([^"]+)"/.exec(item)?.[1];
    const daysLeft = expires
      ? Math.floor((Date.parse(expires) - Date.now()) / 86_400_000)
      : null;
    const cover = await first.cover();
    const listed = await first.reports();
    const stale = listed.reports.flatMap((r) => r.samples.filter(leftover));
    if (
      cover.text !== "" ||
      listed.reports.some(
        (r) =>
          holdsRules(r) ||
          r.samples.length >= SERVED ||
          !r.samples.every(leftover),
      )
    )
      fail("account_holds_foreign_data");
    const warn = daysLeft !== null && daysLeft < KEY_WARN_DAYS;
    done(
      {
        key_days_left: daysLeft,
        leftovers: stale.length,
        ...(warn ? { warning: "key_expires_within_30_days" } : {}),
      },
      warn ? "WARNING" : "INFO",
    );

    step = "retire_leftovers";
    if (stale.length)
      await first.save({
        text: "Retire samples a crashed Milton e2e check left behind.",
        retire_samples: stale.map((s) => s.id),
        expected_version: cover.version,
      });
    done({ retired: stale.length });

    step = "baseline";
    const start = await first.cover();
    const startReports = await first.reports();
    if (!start.is_empty) fail("account_not_empty");
    done();

    step = "save_sample";
    const summary = `${MARKER}, run ${run}`;
    const body = `Fictional note for the ${MARKER}, run ${run}: the tide table is taped inside the shed door.`;
    await first.save({
      text: "File a fictional sample for the Milton e2e check.",
      sample: {
        report: REPORT,
        new_kind: KIND,
        context: { version: 1, summary },
        text: body,
      },
      expected_version: start.version,
    });
    done({ run });

    step = "fresh_read";
    const saved = await (await session()).report();
    const sample = saved.samples[0];
    if (
      saved.samples.length !== 1 ||
      !sample ||
      sample.kind !== KIND ||
      sample.revision !== 1 ||
      Object.keys(sample.context).length !== 2 ||
      sample.context.version !== 1 ||
      sample.context.summary !== summary ||
      !saved.text.includes(quoted(body))
    )
      fail("sample_not_served_exactly");
    done();

    step = "revise_sample";
    const revised = body.replace("shed door.", "shed door, next to the hose.");
    await first.save({
      text: "Revise the fictional Milton e2e check sample.",
      sample: {
        report: REPORT,
        kind_id: sample.kind_id,
        sample_id: sample.id,
        context: { version: 1, summary },
        text: revised,
      },
      expected_version: saved.version,
    });
    done();

    step = "fresh_read_revision";
    const reread = await (await session()).report();
    const current = reread.samples[0];
    if (
      reread.samples.length !== 1 ||
      current?.id !== sample.id ||
      current.revision !== 2 ||
      !reread.text.includes(quoted(revised)) ||
      reread.text.includes(quoted(body))
    )
      fail("revision_not_served");
    done();

    step = "retire_sample";
    const retired = await first.save({
      text: "Retire the fictional Milton e2e check sample.",
      retire_samples: [sample.id],
      expected_version: reread.version,
    });
    if (!retired.samples_retired?.some((s) => s.id === sample.id))
      fail("sample_not_retired");
    done();

    step = "cleanup";
    const last = await session();
    const end = await last.cover();
    const endReports = await last.reports();
    if (
      !end.is_empty ||
      end.version !== start.version ||
      JSON.stringify(endReports) !== JSON.stringify(startReports)
    )
      fail("baseline_not_restored");
    done();

    report({
      step: "done",
      ok: true,
      ms: Date.now() - begun,
      severity: "INFO",
      run,
    });
  } catch (error) {
    report({
      step,
      ok: false,
      ms: Date.now() - started,
      severity: "ERROR",
      error: error instanceof CheckError ? error.code : "unexpected",
    });
    throw error;
  } finally {
    await Promise.allSettled(sessions.map((s) => s.close()));
  }
}

if (import.meta.main) {
  const secrets = process.argv[2];
  if (!secrets || process.argv.length !== 3) {
    console.error(`Usage:
  bun --no-env-file server/scripts/e2e.ts <test account env file>

Runs the end-to-end check against production on the fictional test account only.
The file holds E2E_EMAIL, E2E_PASSWORD and E2E_CONNECTION_KEY (test-account.ts).`);
    process.exit(2);
  }
  try {
    await runE2E({ secrets });
  } catch {
    process.exitCode = 1;
  }
}
