// FROZEN: server/scripts/e2e.ts as released (origin/main c8d1c22), the image the
// milton-e2e-daily job runs until its image is updated. The integration suite
// runs it against the new server to show the old job fails closed before
// writing. Never edited; removed once that image is no longer a rollback
// target.
/** The daily end-to-end check, safe against production because it touches only
 * the fictional test account (test-account.ts). It signs in as a browser does,
 * connects to MCP with the account's connection key, refuses to write unless the
 * account holds nothing but this check's own marked leftovers, then saves a
 * marked final-only memo, reads it fresh, saves a marked edit-mode memo with a
 * first draft so code lists its one change, finds that change on the memo's
 * page, forgets both and confirms the account is
 * back where the run began. One JSON line per step on stdout (`step`, `ok`,
 * `ms`, `severity`), never a password, key, cookie or memo text. Exit 0 only when every step passed. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fictionalEmail } from "../../apps/auth/src/recipient.ts";
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
} from "./e2e-http";

/** Every memo this check writes carries the marker in its context summary and
 * files under this kind, so a crashed run's leftovers are recognized. */
export const MARKER = "Milton e2e check";
export const KIND = "e2e check";
const INTENT = {
  situation: "confirming what is on file",
  medium: "document",
  audience: "the Milton e2e check",
  purpose: "check",
};
/** The whole run's bound: past it the process exits 1. */
export const RUN_MS = 240_000;
/** The check warns, without failing, when the key has fewer days left. */
export const KEY_WARN_DAYS = 30;
/** More leftovers than this means something other than crashed runs. */
const MAX_LEFTOVERS = 5;
const TOOLS = ["create_memo", "get_cover_sheet", "get_report"];

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

type Cover = {
  text: string;
  version: number;
  memos: number;
  tweaks: number;
  is_empty: boolean;
};
type Report = {
  report_id: string;
  text: string;
  examples: { memo_id: string; kind?: string; tier: string }[];
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
    cover: () => call<Cover>("get_cover_sheet"),
    report: () => call<Report>("get_report", { intent: INTENT }),
    save: async (args: object) => {
      const outcome = await call<{
        status: string;
        memo?: {
          memo_id: string;
          tier: string;
          kind?: string;
          changes?: { state: string; found: number };
        };
        receipt?: string;
        forgotten?: string[];
      }>("create_memo", { request_id: randomUUID(), ...args });
      if (outcome.status !== "saved") fail(`create_memo_${outcome.status}`);
      return outcome;
    },
    close: () => client.close(),
  };
}
type Session = Awaited<ReturnType<typeof mcpSession>>;

/** This check's own leftovers in a report: its kind, the person's own words,
 * and a summary carrying the run marker. The summary is read from each
 * example's Situation line, in served order; a memo of the kind without the
 * marker is the person's and is never forgotten. */
const leftovers = (listed: Report) => {
  const situations = [
    ...listed.text.matchAll(/^## \d+\. .*\nSituation: (.*)$/gm),
  ].map((m) => m[1]!);
  if (situations.length !== listed.examples.length) return [];
  return listed.examples.filter(
    (e, i) =>
      e.kind === KIND &&
      e.tier === "own" &&
      situations[i]!.startsWith(`${MARKER}, run `),
  );
};
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

    // The key is used only once the signed-in test account's own key list
    // shows its public id: a key from another account is never sent to MCP,
    // so it is never authenticated or marked used.
    step = "key_owner";
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
    const warn = daysLeft !== null && daysLeft < KEY_WARN_DAYS;
    done(
      {
        key_days_left: daysLeft,
        ...(warn ? { warning: "key_expires_within_30_days" } : {}),
      },
      warn ? "WARNING" : "INFO",
    );

    step = "mcp_connect";
    const first = await session();
    if ((await first.tools()).join() !== TOOLS.join()) fail("tools_unexpected");
    done({ tools: TOOLS.length });

    // Nothing is written until the account holds only this check's marked
    // leftovers: no cover sheet, no tweaks, and every memo one of this
    // check's, by kind and run marker (a few small ones all fit in one
    // report).
    step = "safety_gate";
    const cover = await first.cover();
    const listed = await first.report();
    const stale = leftovers(listed);
    if (
      cover.text !== "" ||
      cover.tweaks !== 0 ||
      cover.memos > MAX_LEFTOVERS ||
      stale.length !== cover.memos ||
      stale.length !== listed.examples.length
    )
      fail("account_holds_foreign_data");
    done({ leftovers: stale.length });

    step = "forget_leftovers";
    if (stale.length)
      await first.save({ forget_memos: stale.map((e) => e.memo_id) });
    done({ forgotten: stale.length });

    step = "baseline";
    const start = await first.cover();
    if (!start.is_empty || start.memos !== 0) fail("account_not_empty");
    done();

    step = "save_memo";
    const summary = `${MARKER}, run ${run}`;
    const final = `Fictional note for the ${MARKER}, run ${run}: the tide table is taped inside the shed door.`;
    const saved = await first.save({
      memo: {
        final,
        context: { summary, medium: INTENT.medium },
        new_kind: KIND,
      },
    });
    if (
      saved.memo?.tier !== "own" ||
      saved.memo.kind !== KIND ||
      saved.receipt !== `Kept memo: ${KIND}, your words.`
    )
      fail("memo_not_saved_as_sent");
    done({ run });

    step = "fresh_read";
    const fresh = await (await session()).report();
    const example = fresh.examples[0];
    if (
      fresh.examples.length !== 1 ||
      example?.memo_id !== saved.memo.memo_id ||
      !fresh.text.includes(`Situation: ${summary}`) ||
      !fresh.text.includes(quoted(final))
    )
      fail("memo_not_served_exactly");
    done();

    // A drafted memo whose final differs from its first draft in one spot,
    // so code's diff runs in production and stores one change row: edit
    // mode, so it is the person's words and a crashed run's leftover is
    // recognized like the first; no tweaks, so none is left.
    step = "save_drafted";
    const lead = `Fictional reminder for the ${MARKER}, run ${run}: the spare key`;
    const drafted = await first.save({
      memo: {
        first_draft: `${lead} is by the door.`,
        final: `${lead} hangs by the shed door.`,
        mode: "edit",
        rounds: 0,
        context: { summary, medium: INTENT.medium },
        new_kind: KIND,
      },
    });
    if (
      drafted.memo?.tier !== "own" ||
      drafted.memo.kind !== KIND ||
      drafted.memo.changes?.state !== "itemized" ||
      drafted.memo.changes.found !== 1 ||
      drafted.receipt !== `Kept memo: ${KIND}, 0 rounds.`
    )
      fail("drafted_memo_not_saved_as_sent");
    done();

    // The stored row, as the person's memo page lists it.
    step = "drafted_changes";
    const page = await b.follow(
      `${origins.app}/tps/memo/${drafted.memo.memo_id}`,
    );
    if (
      page.status !== 200 ||
      page.html.split('<li class="change-row">').length !== 2 ||
      !page.html.includes("“is by the”") ||
      !page.html.includes("“hangs by the shed”")
    )
      fail("drafted_changes_not_listed");
    done();

    step = "forget_memo";
    const ids = [example.memo_id, drafted.memo.memo_id];
    const forgotten = await first.save({ forget_memos: ids });
    if (!ids.every((id) => forgotten.forgotten?.includes(id)))
      fail("memo_not_forgotten");
    done();

    step = "cleanup";
    const last = await session();
    const end = await last.cover();
    const endReport = await last.report();
    if (
      !end.is_empty ||
      end.version !== start.version ||
      end.memos !== 0 ||
      end.tweaks !== 0 ||
      endReport.examples.length !== 0
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
  // Every failure is a non-zero exit, one failed job execution: a refusal or a
  // failed step (runE2E's own ERROR line), a crash outside it, or a run past
  // RUN_MS, well inside the job's 300 s task timeout.
  const crash = (step: string, error: string) => {
    print({ step, ok: false, ms: 0, severity: "ERROR", error });
    process.exit(1);
  };
  process.on("uncaughtException", () => crash("process", "unexpected"));
  process.on("unhandledRejection", () => crash("process", "unexpected"));
  setTimeout(() => crash("deadline", "run_timeout"), RUN_MS).unref();
  let code = 0;
  try {
    await runE2E({ secrets });
  } catch {
    code = 1;
  }
  process.exit(code);
}
