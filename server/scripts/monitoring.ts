// Production alerts as code: server/deploy/monitoring/ holds one JSON file per
// resource, in the Monitoring and Logging APIs' own shapes. Dry run by default:
// prints create/update/unchanged/delete per resource and changes nothing.
// `--apply` upserts by display name (log metrics by name), then deletes only the
// legacy policies named below. A second `--apply` changes nothing. The token comes
// from `gcloud auth print-access-token` and is never printed.
//
//   bun server/scripts/monitoring.ts            # plan against production
//   bun server/scripts/monitoring.ts --apply    # release coordinator only
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT = "milton-510506";
/** The only notification channel a definition may name, by display name. */
export const EMAIL_CHANNEL = "milton-ops-email";
export const DEFINITIONS_DIR = join(
  import.meta.dir,
  "..",
  "deploy",
  "monitoring",
);

/** Today's hand-made policies (2026-11-04 and 11-07), replaced by the files. */
export const LEGACY_POLICIES = [
  ["7404280805921002084", "milton-app-5xx-ratio"],
  ["8497634747547041760", "milton-mcp-5xx-ratio"],
  ["15828344147061748250", "milton-app-latency-p95"],
  ["15828344147061748829", "milton-mcp-latency-p95"],
  ["7816623155069320433", "milton-app-instances"],
  ["15828344147061751332", "milton-mcp-instances"],
  ["13538757547882180165", "milton-app-errors-log"],
  ["10576224811705121743", "milton-mcp-errors-log"],
  ["2514220272634762767", "milton-auth-errors-log"],
  ["1402551501086603102", "milton-auth-jobs-errors-log"],
] as const;

type Json = Record<string, unknown>;
export type Kind = "metric" | "uptime" | "policy";
export type Definition = { kind: Kind; file: string; key: string; body: Json };

const KINDS: Record<string, Kind> = {
  ".metric.json": "metric",
  ".uptime.json": "uptime",
  ".policy.json": "policy",
};
const ORDER: Kind[] = ["metric", "uptime", "policy"];

/** Top-level files only: `pending/` holds definitions kept out of the applied set. */
export function loadDefinitions(dir = DEFINITIONS_DIR): Definition[] {
  const defs: Definition[] = [];
  for (const file of readdirSync(dir).sort()) {
    const suffix = Object.keys(KINDS).find((s) => file.endsWith(s));
    if (!suffix) continue;
    const kind = KINDS[suffix]!;
    const body = JSON.parse(readFileSync(join(dir, file), "utf8")) as Json;
    const key = String(kind === "metric" ? body.name : body.displayName);
    if (!key || key === "undefined") throw new Error(`${file}: no name`);
    if (defs.some((d) => d.kind === kind && d.key === key))
      throw new Error(`${file}: duplicate ${kind} ${key}`);
    defs.push({ kind, file, key, body });
  }
  return defs.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** Replaces the email channel's display name with its resource name; refuses anything else. */
export function resolveChannels(body: Json, emailChannelName: string): Json {
  const channels = body.notificationChannels;
  if (channels === undefined) return body;
  if (!Array.isArray(channels))
    throw new Error("notificationChannels: not a list");
  for (const c of channels)
    if (c !== EMAIL_CHANNEL)
      throw new Error(`refusing notification channel ${JSON.stringify(c)}`);
  return {
    ...body,
    notificationChannels: channels.map(() => emailChannelName),
  };
}

// The APIs omit proto3 default values ("0s", 0, false, empty lists) from responses.
function isDefault(v: unknown): boolean {
  if (
    v === undefined ||
    v === null ||
    v === "" ||
    v === "0s" ||
    v === 0 ||
    v === false
  )
    return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Json).every(isDefault);
  return false;
}

// Filters compare with whitespace outside quoted strings ignored.
function normalizeFilter(s: string) {
  return s.replace(
    /("(?:[^"\\]|\\.)*")|\s+/g,
    (_m, quoted?: string) => quoted ?? "",
  );
}

/** Paths where `actual` does not carry `desired`; fields only the server sets are ignored. */
export function diff(desired: unknown, actual: unknown, path = ""): string[] {
  if (actual === undefined || actual === null)
    return isDefault(desired) ? [] : [path || "."];
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || actual.length !== desired.length)
      return [path];
    return desired.flatMap((d, i) => diff(d, actual[i], `${path}[${i}]`));
  }
  if (desired && typeof desired === "object") {
    if (typeof actual !== "object" || Array.isArray(actual)) return [path];
    return Object.entries(desired as Json).flatMap(([k, v]) =>
      diff(v, (actual as Json)[k], path ? `${path}.${k}` : k),
    );
  }
  if (typeof desired === "string" && /(^|\.)(denominatorF|f)ilter$/.test(path))
    return normalizeFilter(desired) === normalizeFilter(String(actual))
      ? []
      : [path];
  return String(desired) === String(actual) ? [] : [path];
}

export type Action =
  | { op: "create"; def: Definition }
  | { op: "update"; def: Definition; name: string; fields: string[] }
  | { op: "unchanged"; def: Definition }
  | { op: "delete"; name: string; displayName: string };

/** Pure planning step: what `--apply` would do given the live resources. */
export function plan(
  defs: Definition[],
  live: { metrics: Json[]; uptime: Json[]; policies: Json[] },
  emailChannelName: string,
): Action[] {
  const actions: Action[] = [];
  for (const def of defs) {
    const body =
      def.kind === "policy"
        ? resolveChannels(def.body, emailChannelName)
        : def.body;
    const pool =
      def.kind === "metric"
        ? live.metrics.filter((m) => m.name === def.key)
        : (def.kind === "uptime" ? live.uptime : live.policies).filter(
            (r) => r.displayName === def.key,
          );
    if (pool.length > 1)
      throw new Error(
        `${pool.length} live ${def.kind} resources named ${def.key}`,
      );
    const existing = pool[0];
    if (!existing) {
      actions.push({ op: "create", def: { ...def, body } });
      continue;
    }
    const fields = diff(body, existing);
    if (
      def.kind === "uptime" &&
      fields.some((f) => f.startsWith("monitoredResource"))
    )
      throw new Error(
        `${def.key}: monitoredResource differs; recreate it by hand`,
      );
    actions.push(
      fields.length
        ? {
            op: "update",
            def: { ...def, body },
            name: String(existing.name),
            fields,
          }
        : { op: "unchanged", def },
    );
  }
  for (const [id, displayName] of LEGACY_POLICIES) {
    const name = `projects/${PROJECT}/alertPolicies/${id}`;
    const p = live.policies.find((x) => x.name === name);
    if (p && p.displayName === displayName)
      actions.push({ op: "delete", name, displayName });
  }
  return actions;
}

const MONITORING = `https://monitoring.googleapis.com/v3/projects/${PROJECT}`;
const LOGGING = `https://logging.googleapis.com/v2/projects/${PROJECT}`;

function accessToken() {
  const out = Bun.spawnSync(["gcloud", "auth", "print-access-token"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (out.exitCode !== 0)
    throw new Error("gcloud auth print-access-token failed");
  return out.stdout.toString().trim();
}

function client(token: string) {
  async function call(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Json> {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 500);
      try {
        message = (JSON.parse(text) as { error: { message: string } }).error
          .message;
      } catch {}
      throw new Error(
        `${method} ${url.split("?")[0]}: ${res.status} ${message}`,
      );
    }
    return text ? (JSON.parse(text) as Json) : {};
  }
  async function list(url: string, field: string): Promise<Json[]> {
    const items: Json[] = [];
    let pageToken = "";
    do {
      const sep = url.includes("?") ? "&" : "?";
      const page = await call(
        "GET",
        pageToken
          ? `${url}${sep}pageToken=${encodeURIComponent(pageToken)}`
          : url,
      );
      items.push(...((page[field] as Json[] | undefined) ?? []));
      pageToken = String(page.nextPageToken ?? "");
    } while (pageToken);
    return items;
  }
  return { call, list };
}

function mask(fields: string[]) {
  return [...new Set(fields.map((f) => f.split(/[.[]/)[0]))].join(",");
}

function describe(a: Action) {
  if (a.op === "delete")
    return `delete     policy  ${a.displayName}  (legacy, ${a.name})`;
  const head = `${a.op.padEnd(10)} ${a.def.kind.padEnd(7)} ${a.def.key}  (${a.def.file})`;
  return a.op === "update"
    ? `${head}\n             changes: ${a.fields.join(", ")}`
    : head;
}

async function main(argv: string[]) {
  const unknown = argv.filter((a) => a !== "--apply");
  if (unknown.length)
    throw new Error(`unknown argument ${unknown[0]}; only --apply`);
  const apply = argv.includes("--apply");
  const defs = loadDefinitions();
  const api = client(accessToken());

  const channels = (
    await api.list(`${MONITORING}/notificationChannels`, "notificationChannels")
  ).filter((c) => c.displayName === EMAIL_CHANNEL);
  if (channels.length !== 1 || channels[0]!.type !== "email")
    throw new Error(
      `expected exactly one email channel named ${EMAIL_CHANNEL}`,
    );
  const emailChannel = String(channels[0]!.name);

  const live = {
    metrics: await api.list(`${LOGGING}/metrics`, "metrics"),
    uptime: await api.list(
      `${MONITORING}/uptimeCheckConfigs`,
      "uptimeCheckConfigs",
    ),
    policies: await api.list(`${MONITORING}/alertPolicies`, "alertPolicies"),
  };
  const actions = plan(defs, live, emailChannel);
  const pending = readdirSync(join(DEFINITIONS_DIR, "pending")).filter((f) =>
    f.endsWith(".json"),
  );

  console.log(
    `${apply ? "Applying" : "Plan (dry run)"} for ${PROJECT}, channel ${EMAIL_CHANNEL}:`,
  );
  for (const a of actions) console.log(`  ${describe(a)}`);
  for (const f of pending)
    console.log(`  skip       pending ${f} (not in the applied set)`);
  const counts = ["create", "update", "unchanged", "delete"].map(
    (op) => `${actions.filter((a) => a.op === op).length} ${op}`,
  );
  console.log(counts.join(", "));
  if (!apply) return;

  for (const a of actions) {
    if (a.op === "unchanged" || a.op === "delete") continue;
    const { kind, key, body } = a.def;
    if (kind === "metric") {
      if (a.op === "create") await api.call("POST", `${LOGGING}/metrics`, body);
      else
        await api.call(
          "PUT",
          `${LOGGING}/metrics/${encodeURIComponent(key)}`,
          body,
        );
    } else {
      const collection =
        kind === "uptime" ? "uptimeCheckConfigs" : "alertPolicies";
      const fields =
        a.op === "update"
          ? a.fields.filter((f) => !f.startsWith("monitoredResource"))
          : [];
      await untilMetricsExist(() =>
        a.op === "create"
          ? api.call("POST", `${MONITORING}/${collection}`, body)
          : api.call(
              "PATCH",
              `https://monitoring.googleapis.com/v3/${a.name}?updateMask=${encodeURIComponent(mask(fields))}`,
              body,
            ),
      );
    }
    console.log(`  done: ${a.op} ${kind} ${key}`);
  }
  for (const a of actions)
    if (a.op === "delete") {
      await api.call(
        "DELETE",
        `https://monitoring.googleapis.com/v3/${a.name}`,
      );
      console.log(`  done: delete policy ${a.displayName}`);
    }
}

// A new log-based metric can take up to 10 minutes to become usable in a policy;
// until then Monitoring answers 404 "Cannot find metric(s)". Retry only that.
async function untilMetricsExist(send: () => Promise<Json>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const missing =
        error instanceof Error && error.message.includes("Cannot find metric");
      if (!missing || attempt === 45) throw error;
      if (attempt === 1)
        console.log("  waiting for new log-based metrics (up to 11 min)");
      await Bun.sleep(15_000);
    }
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
