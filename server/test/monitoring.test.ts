import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFINITIONS_DIR,
  diff,
  EMAIL_CHANNEL,
  LEGACY_POLICIES,
  loadDefinitions,
  plan,
  resolveChannels,
} from "../scripts/monitoring";

type Condition = {
  displayName: string;
  conditionThreshold?: {
    duration: string;
    aggregations: { alignmentPeriod: string }[];
  };
  conditionAbsent?: { duration: string };
};
type Policy = {
  displayName: string;
  userLabels: { tier: "page" | "gate" };
  documentation?: { content: string; mimeType: string };
  notificationChannels: string[];
  alertStrategy: {
    autoClose?: string;
    notificationRateLimit?: { period: string };
    notificationPrompts?: string[];
    notificationChannelStrategy?: unknown;
  };
  conditions: (Condition & { conditionMatchedLog?: unknown })[];
};

const seconds = (d: string) => Number(d.replace(/s$/, ""));
const pendingDir = join(DEFINITIONS_DIR, "pending");
// Empty once every pending definition is applied; git keeps no empty folder.
const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
const policies = [
  ...loadDefinitions()
    .filter((d) => d.kind === "policy")
    .map((d) => d.body),
  ...pendingFiles.map((f) =>
    JSON.parse(readFileSync(join(pendingDir, f), "utf8")),
  ),
] as Policy[];

// The spec's stated minimum hold (duration) and window (alignment period) per condition.
const MINIMUMS: [RegExp, { duration: number; window: number }][] = [
  [/^health check failing/, { duration: 600, window: 300 }],
  [/ 5xx: ≥ 10 in 15 min/, { duration: 300, window: 900 }],
  [/ latency: p95/, { duration: 1800, window: 300 }],
  [/ ERROR logs: ≥ 10 in 15 min/, { duration: 300, window: 900 }],
  [/ instances: > 8 for 15 min/, { duration: 900, window: 60 }],
  [/^milton-auth-mail: ≥ 5 failed/, { duration: 0, window: 900 }],
  [
    /^milton-auth-mail: ≥ 3 failed or throttled sends/,
    { duration: 0, window: 900 },
  ],
  [/^milton-auth-maint: ≥ 2 failed/, { duration: 0, window: 2700 }],
  [/^milton-auth-mail: no execution for 20 min/, { duration: 1200, window: 0 }],
  [
    /^milton-auth-maint: no execution for 45 min/,
    { duration: 2700, window: 0 },
  ],
  [/^startup failures/, { duration: 0, window: 900 }],
  [/^gate: /, { duration: 0, window: 300 }],
  [/^milton-e2e-daily: ≥ 1 failed/, { duration: 0, window: 86400 }],
  [/^milton-e2e-daily: no execution for 13 h/, { duration: 46800, window: 0 }],
];

test("page policies email only the ops channel, once per incident, and auto-close", () => {
  const page = policies.filter((p) => p.userLabels.tier === "page");
  expect(page.map((p) => p.displayName).sort()).toEqual([
    "milton-app",
    "milton-auth",
    "milton-auth-mail",
    "milton-e2e-daily",
    "milton-instance-start",
    "milton-jobs",
    "milton-mcp",
    "milton-uptime",
  ]);
  for (const p of page) {
    expect(p.notificationChannels).toEqual([EMAIL_CHANNEL]);
    expect(p.alertStrategy.autoClose).toBe("1800s");
    expect(p.alertStrategy.notificationChannelStrategy).toBeUndefined();
    // The API implements notificationRateLimit only for log-match conditions;
    // metric policies notify on open only, so one email per incident.
    if (p.conditions.some((c) => c.conditionMatchedLog))
      expect(
        seconds(p.alertStrategy.notificationRateLimit!.period),
      ).toBeGreaterThanOrEqual(3600);
    else expect(p.alertStrategy.notificationPrompts).toEqual(["OPENED"]);
    expect(p.documentation?.mimeType).toBe("text/markdown");
    expect(p.documentation?.content).toContain("Check first");
    expect(p.documentation?.content).toContain("Reason:");
  }
});

test("the release gate emails no one", () => {
  const gate = policies.filter((p) => p.userLabels.tier === "gate");
  expect(gate.map((p) => p.displayName)).toEqual(["milton-release-gate"]);
  expect(gate[0]!.notificationChannels).toEqual([]);
  expect(gate[0]!.alertStrategy.autoClose).toBe("1800s");
});

test("every condition holds at least its stated duration and window", () => {
  for (const c of policies.flatMap((p) => p.conditions)) {
    const min = MINIMUMS.find(([re]) => re.test(c.displayName))?.[1];
    expect(min, c.displayName).toBeDefined();
    const spec = c.conditionThreshold ?? c.conditionAbsent;
    expect(spec, c.displayName).toBeDefined();
    expect(seconds(spec!.duration)).toBeGreaterThanOrEqual(min!.duration);
    if (c.conditionThreshold)
      expect(
        seconds(c.conditionThreshold.aggregations[0]!.alignmentPeriod),
      ).toBeGreaterThanOrEqual(min!.window);
  }
});

test("no definition names another notification channel or type", () => {
  const files = [
    ...readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith(".json")),
    ...pendingFiles.map((f) => join("pending", f)),
  ];
  for (const f of files) {
    const text = readFileSync(join(DEFINITIONS_DIR, f), "utf8");
    expect(text, f).not.toMatch(/notificationChannels\//);
    expect(text, f).not.toMatch(
      /\b(slack|sms|webhook\w*|pagerduty|pubsub|campfire|hipchat|google_chat)\b/i,
    );
  }
  expect(() =>
    resolveChannels({ notificationChannels: ["milton-other"] }, "x"),
  ).toThrow("refusing notification channel");
});

test("a second apply plans no change, and only the named legacy policies are deleted", () => {
  const defs = loadDefinitions();
  const channel = "projects/milton-510506/notificationChannels/1";
  // What the APIs return after the first apply: server fields added, proto defaults dropped.
  const echo = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(echo)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(
                ([, x]) =>
                  x !== "0s" && x !== 0 && !(Array.isArray(x) && !x.length),
              )
              .map(([k, x]) => [k, echo(x)]),
          )
        : v;
  const live = (kind: string) =>
    defs
      .filter((d) => d.kind === kind)
      .map((d, i) => ({
        ...(echo(
          kind === "policy" ? resolveChannels(d.body, channel) : d.body,
        ) as object),
        name:
          kind === "metric" ? (d.body.name as string) : `server/${kind}/${i}`,
        creationRecord: { mutateTime: "2026-11-08T00:00:00Z" },
      }));
  const [legacyId, legacyName] = LEGACY_POLICIES[0];
  const policiesLive = [
    ...live("policy"),
    {
      name: `projects/milton-510506/alertPolicies/${legacyId}`,
      displayName: legacyName,
    },
    {
      name: "projects/milton-510506/alertPolicies/9",
      displayName: "someone-elses",
    },
  ];
  const actions = plan(
    defs,
    { metrics: live("metric"), uptime: live("uptime"), policies: policiesLive },
    channel,
  );
  expect(actions.filter((a) => a.op !== "unchanged")).toEqual([
    {
      op: "delete",
      name: `projects/milton-510506/alertPolicies/${legacyId}`,
      displayName: legacyName,
    },
  ]);
  expect(diff({ filter: 'a = "x y"' }, { filter: 'a="x y"' })).toEqual([]);
  expect(diff({ filter: 'a = "x y"' }, { filter: 'a = "xy"' })).toEqual([
    "filter",
  ]);
});

test("the auth mail alert counts the delivery job's own failed and throttled lines, 3 in 15 min", async () => {
  const { problemLine } = await import("../../apps/auth/src/mail-log.ts");
  const defs = loadDefinitions();
  const metric = defs.find(
    (d) => d.kind === "metric" && d.key === "milton-auth-mail-problems",
  )!.body as { filter: string };
  // The filter reads exactly the fields the job writes, as jsonPayload.
  const lines = (["failed", "throttled"] as const).map(
    (o) => JSON.parse(problemLine(o)) as Record<string, string>,
  );
  expect(lines.map((l) => Object.keys(l))).toEqual([
    ["message", "outcome"],
    ["message", "outcome"],
  ]);
  expect(metric.filter).toBe(
    'resource.type="cloud_run_job" AND resource.labels.job_name="milton-auth-mail"' +
      ` AND jsonPayload.message="${lines[0]!.message}"` +
      ` AND jsonPayload.outcome=("${lines[0]!.outcome}" OR "${lines[1]!.outcome}")`,
  );
  // A sent or retried send writes no line.
  expect(lines.map((l) => l.outcome)).toEqual(["failed", "throttled"]);
  const policy = policies.find((p) => p.displayName === "milton-auth-mail")!;
  expect(policy.conditions).toHaveLength(1);
  const threshold = policy.conditions[0]!.conditionThreshold as unknown as {
    filter: string;
    comparison: string;
    thresholdValue: number;
    duration: string;
    aggregations: Record<string, unknown>[];
  };
  expect(threshold.filter).toBe(
    'metric.type = "logging.googleapis.com/user/milton-auth-mail-problems" AND resource.type = "cloud_run_job" AND resource.labels.job_name = "milton-auth-mail"',
  );
  // 3 or more in a rolling 15 minutes: GT 2, summed over the window.
  expect([threshold.comparison, threshold.thresholdValue]).toEqual([
    "COMPARISON_GT",
    2,
  ]);
  expect(threshold.duration).toBe("0s");
  expect(threshold.aggregations).toEqual([
    {
      alignmentPeriod: "900s",
      perSeriesAligner: "ALIGN_DELTA",
      crossSeriesReducer: "REDUCE_SUM",
      groupByFields: ["resource.label.job_name"],
    },
  ]);
});
