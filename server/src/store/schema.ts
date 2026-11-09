import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  unique,
  uniqueIndex,
  foreignKey,
  index,
  check,
  customType,
  doublePrecision,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
// Changing this default needs a migration. Application code reads body_bytes,
// description_bytes and report_body_bytes; nothing reads reason_bytes since the
// card version guard went with the old writing tables (0013).
const limits = {
  body_bytes: 131072,
  description_bytes: 500,
  reason_bytes: 500,
  report_body_bytes: 262144,
};
export const storeConfig = pgTable(
  "store_config",
  {
    singleton: integer("singleton").primaryKey(),
    trialsEnabled: boolean("trials_enabled").notNull().default(false),
    limits: jsonb("limits_json").notNull().default(limits),
  },
  (t) => [
    check("config_singleton", sql`${t.singleton} = 1`),
    check("config_limits_object", sql`jsonb_typeof(${t.limits}) = 'object'`),
  ],
);
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    // Set only by the owner (migrations/011-test-account-roles.sql): marks the
    // fictional end-to-end check account, which usage and metric counts exclude.
    testAccount: boolean("test_account").notNull().default(false),
  },
  (t) => [
    check("users_status", sql`${t.status} IN ('active','deleting')`),
    check(
      "users_id_format",
      sql`${t.id} <> '' AND position(':' in ${t.id}) = 0`,
    ),
  ],
);
// No row, or a row with no status, reads as early access. Rows are created by
// first sign-in, with no status while trials_enabled is on, or canceled for an
// account whose trial-eligibility fingerprint an earlier account claimed
// (milton_app.trial_fingerprint) whether trials are on or off; and by
// the subscription backfill script (enrollForBackfill), with no status, for an
// active account that has none. Stripe owns the trial and the subscription: the
// stripe_* columns and subscription_status mirror what Stripe last answered, and
// the gate reads only those. startedAt and paidThrough stay in place, unread by
// the gate. subscriptionStatus holds any value Stripe sends; NULL means no
// subscription yet, and the gate allows it.
export const trialAccounts = pgTable(
  "trial_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    paidThrough: timestamp("paid_through", { withTimezone: true }),
    noticeStage: integer("notice_stage").notNull().default(0),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    subscriptionStatus: text("subscription_status"),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // Advances on every write of the Stripe state above, values unchanged
    // included (0011).
    stripeRevision: bigint("stripe_revision", { mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => [
    check("trial_notice_stage", sql`${t.noticeStage} BETWEEN 0 AND 2`),
    check(
      "trial_stripe_customer",
      sql`${t.stripeCustomerId} IS NULL OR ${t.stripeCustomerId} ~ '^cus_[A-Za-z0-9]{1,251}$'`,
    ),
    check(
      "trial_stripe_subscription",
      sql`${t.stripeSubscriptionId} IS NULL OR ${t.stripeSubscriptionId} ~ '^sub_[A-Za-z0-9]{1,251}$'`,
    ),
    check(
      "trial_subscription_status",
      sql`${t.subscriptionStatus} IS NULL OR char_length(${t.subscriptionStatus}) BETWEEN 1 AND 64`,
    ),
    check(
      "trial_stripe_dates",
      sql`(${t.trialEnd} IS NULL OR isfinite(${t.trialEnd})) AND (${t.currentPeriodStart} IS NULL OR isfinite(${t.currentPeriodStart})) AND (${t.currentPeriodEnd} IS NULL OR isfinite(${t.currentPeriodEnd}))`,
    ),
    check(
      "trial_finite_dates",
      sql`(${t.startedAt} IS NULL OR isfinite(${t.startedAt})) AND (${t.paidThrough} IS NULL OR isfinite(${t.paidThrough}))`,
    ),
  ],
);

export const identities = pgTable(
  "identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index("identities_by_user").on(t.userId),
    check("identities_subject", sql`${t.subject} <> ''`),
  ],
);
// Assistants a person disconnected from Milton, keyed by sign-in identity and
// OAuth client. No foreign key to users: a row outlives account deletion so a
// later account for the same identity stays protected until reconnection.
export const assistantDisconnects = pgTable(
  "assistant_disconnects",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    clientId: text("client_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject, t.clientId] }),
    check(
      "assistant_disconnects_bounds",
      sql`char_length(${t.provider}) BETWEEN 1 AND 64 AND char_length(${t.subject}) BETWEEN 1 AND 512 AND char_length(${t.clientId}) BETWEEN 1 AND 2048`,
    ),
  ],
);
// Bearer keys a person creates for headless agents. Only the SHA-256 of the
// key's secret is stored; the full key is shown once, at creation. A key is
// refused once revoked_at is set or expires_at has passed; NULL expires_at
// never expires. Account deletion removes the account's keys.
// Each key is bound to the native identity (issuer, subject) and the identity
// incarnation and security generation of the fresh session that created it.
// No runtime may change the binding: a native recovery, security change or
// deletion stops the key for good, and it is never moved to a newer generation.
export const connectionKeys = pgTable(
  "connection_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    incarnation: text("incarnation").notNull(),
    generation: text("generation").notNull(),
    secretHash: text("secret_hash").notNull(),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("connection_keys_by_user").on(t.userId),
    index("connection_keys_by_identity").on(t.issuer, t.subject),
    foreignKey({
      name: "connection_keys_identity_fk",
      columns: [t.issuer, t.subject],
      foreignColumns: [identities.provider, identities.subject],
    }).onDelete("cascade"),
    check(
      "connection_key_binding",
      sql`char_length(${t.issuer}) BETWEEN 1 AND 512 AND char_length(${t.subject}) BETWEEN 1 AND 512 AND char_length(${t.incarnation}) BETWEEN 1 AND 128 AND char_length(${t.generation}) BETWEEN 1 AND 128`,
    ),
    check("connection_key_id", sql`${t.id} ~ '^[A-Za-z0-9_-]{22}$'`),
    check("connection_key_hash", sql`${t.secretHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "connection_key_name",
      sql`char_length(${t.name}) BETWEEN 1 AND 60 AND ${t.name} = btrim(${t.name}) AND ${t.name} !~ '[[:cntrl:]]'`,
    ),
    check("connection_key_scope", sql`${t.scope} IN ('read','read_write')`),
    check(
      "connection_key_dates",
      sql`isfinite(${t.createdAt}) AND (${t.expiresAt} IS NULL OR (isfinite(${t.expiresAt}) AND ${t.expiresAt} > ${t.createdAt}))`,
    ),
  ],
);
// One row per admitted tool call, appended alongside its work. The append
// skips an account under a sign-in's, lifecycle's or deletion's FOR UPDATE
// rather than wait (writers and their guard triggers lock FOR NO KEY UPDATE,
// since 0007), and erasure cascades here, so a row can
// never outlive its account. Outcomes stay in the identity-free logs. Rows
// are kept 90 days: only the auth maintenance job deletes older ones, through
// 0008's prune function, oldest first by usage_calls_by_at.
export const usageCalls = pgTable(
  "usage_calls",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    tool: text("tool").notNull(),
  },
  (t) => [
    index("usage_calls_by_user").on(t.userId, t.at),
    index("usage_calls_by_at").on(t.at),
    check(
      "usage_calls_tool",
      sql`${t.tool} IN ('get_cover_sheet','get_report','list_reports','create_memo')`,
    ),
  ],
);

export const saveRequests = pgTable(
  "save_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    // Never read, and nullable since 0006 so saves can stop writing it; dropped
    // once no running or rollback code writes it (TODO.md).
    sourceHash: text("source_hash"),
    // Written once, with the save's outcome, in the save's transaction.
    result: jsonb("result_json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.requestId] }),
    check(
      "save_request_hashes",
      sql`${t.inputHash} ~ '^[a-f0-9]{64}$' AND ${t.sourceHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check("save_request_id", sql`length(${t.requestId}) = 36`),
    check(
      "save_request_result",
      sql`jsonb_typeof(${t.result}) = 'object' AND octet_length(${t.result}::text) <= 65536`,
    ),
    check("save_request_outcome", sql`(${t.result}->>'status') IS NOT NULL`),
  ],
);

// Stripe webhook events already applied, by event id: a redelivery changes
// nothing. Holds the id, type and a sha256 of the raw body, never the payload.
export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payloadSha256: text("payload_sha256").notNull(),
  },
  (t) => [
    check(
      "stripe_event_shape",
      sql`${t.id} ~ '^evt_[A-Za-z0-9]{1,251}$' AND char_length(${t.type}) BETWEEN 1 AND 128 AND ${t.payloadSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

const oneLineCheck = (column: unknown, max: number) =>
  sql`char_length(${column}) BETWEEN 1 AND ${sql.raw(String(max))} AND ${column} = btrim(${column}) AND ${column} !~ '[[:cntrl:]]'`;
const MEDIA = sql.raw(`('email','chat','post','document','speech')`);

// A personal label for a kind of writing ("vendor decline"), shared by every
// memo of the account. Labels are unique per account regardless of case and
// never change; rows leave only with their account.
export const memoKinds = pgTable(
  "memo_kinds",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    label: text("label").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    uniqueIndex("memo_kinds_label").on(t.userId, sql`lower(${t.label})`),
    check("memo_kinds_label_check", oneLineCheck(t.label, 60)),
  ],
);
// One piece of writing the person settled on: the AI's first draft exactly as
// shown (or none, for writing the person gave; or missing, when the AI no
// longer had it verbatim), the accepted final, and its context. The words
// never change; only the context columns are updatable. tier and change are
// set at save, without a model.
export const memos = pgTable(
  "memos",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    kindId: text("kind_id"),
    medium: text("medium").notNull(),
    summary: text("summary").notNull(),
    audience: text("audience"),
    purpose: text("purpose"),
    // draft or edit; NULL for writing the person gave (no first draft).
    mode: text("mode"),
    firstDraft: text("first_draft"),
    // kept: first_draft holds it; missing: the AI no longer had it; none: the
    // person gave the writing.
    firstDraftState: text("first_draft_state").notNull(),
    final: text("final").notNull(),
    rounds: integer("rounds"),
    // Normalized token Levenshtein, first draft to final, over the longer.
    change: doublePrecision("change"),
    // own: the person's words; steered: a drafted final that differs from
    // its first draft; untouched: a drafted final equal to it.
    tier: text("tier").notNull(),
    // The get_report read before the draft, and the tweak ids it served.
    reportId: text("report_id"),
    servedTweakIds: text("served_tweak_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    clientJson: text("client_json").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: createdAt(),
    contextUpdatedAt: timestamp("context_updated_at", { withTimezone: true }),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, summary || ' ' || coalesce(purpose, '') || ' ' || coalesce(audience, '') || ' ' || final)`,
    ),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      name: "memos_kind_fk",
      columns: [t.userId, t.kindId],
      foreignColumns: [memoKinds.userId, memoKinds.id],
    }).onDelete("cascade"),
    index("memos_by_user").on(t.userId, t.createdAt),
    check("memos_id", sql`${t.id} ~ '^[0-9a-f-]{36}$'`),
    check("memos_medium", sql`${t.medium} IN ${MEDIA}`),
    check("memos_summary", oneLineCheck(t.summary, 200)),
    check(
      "memos_audience",
      sql`${t.audience} IS NULL OR (${oneLineCheck(t.audience, 100)})`,
    ),
    check(
      "memos_purpose",
      sql`${t.purpose} IS NULL OR (${oneLineCheck(t.purpose, 100)})`,
    ),
    check(
      "memos_first_draft",
      sql`${t.firstDraftState} IN ('kept','missing','none') AND (${t.firstDraft} IS NOT NULL) = (${t.firstDraftState} = 'kept') AND (${t.mode} IS NULL) = (${t.firstDraftState} = 'none') AND (${t.rounds} IS NULL) = (${t.firstDraftState} = 'none') AND (${t.change} IS NULL OR ${t.firstDraftState} = 'kept')`,
    ),
    check(
      "memos_mode",
      sql`${t.mode} IS NULL OR ${t.mode} IN ('draft','edit')`,
    ),
    check(
      "memos_words",
      sql`btrim(${t.final}) <> '' AND octet_length(${t.final}) <= 262144 AND (${t.firstDraft} IS NULL OR octet_length(${t.firstDraft}) <= 262144)`,
    ),
    check(
      "memos_rounds",
      sql`${t.rounds} IS NULL OR ${t.rounds} BETWEEN 0 AND 1000`,
    ),
    check(
      "memos_change",
      sql`${t.change} IS NULL OR (${t.change} >= 0 AND ${t.change} <= 1)`,
    ),
    check("memos_tier", sql`${t.tier} IN ('own','steered','untouched')`),
    check(
      "memos_served",
      sql`cardinality(${t.servedTweakIds}) <= 10 AND (${t.reportId} IS NOT NULL OR cardinality(${t.servedTweakIds}) = 0)`,
    ),
    check(
      "memos_client_object",
      sql`jsonb_typeof(${t.clientJson}::jsonb)='object'`,
    ),
    check("memos_request_id", sql`length(${t.requestId}) = 36`),
  ],
);
// One line about what the person made an AI change. Matched through the memos
// that cite it; its count is its number of citations. The person can reword
// it; norm (case, spacing and trailing punctuation folded) keeps one tweak per
// wording, so an exact repeat reuses it.
export const tweaks = pgTable(
  "tweaks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    text: text("text").notNull(),
    norm: text("norm").notNull(),
    clientJson: text("client_json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    unique("tweaks_norm").on(t.userId, t.norm),
    check("tweaks_text", oneLineCheck(t.text, 200)),
    check("tweaks_norm_check", sql`${t.norm} <> ''`),
    check(
      "tweaks_client_object",
      sql`jsonb_typeof(${t.clientJson}::jsonb)='object'`,
    ),
  ],
);
// One row per memo and tweak it taught. Forgetting a memo deletes its rows; a
// tweak left with none is deleted in the same transaction.
export const tweakCitations = pgTable(
  "tweak_citations",
  {
    userId: text("user_id").notNull(),
    memoId: text("memo_id").notNull(),
    tweakId: text("tweak_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.memoId, t.tweakId] }),
    foreignKey({
      name: "tweak_citations_memo_fk",
      columns: [t.userId, t.memoId],
      foreignColumns: [memos.userId, memos.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "tweak_citations_tweak_fk",
      columns: [t.userId, t.tweakId],
      foreignColumns: [tweaks.userId, tweaks.id],
    }).onDelete("cascade"),
    index("tweak_citations_by_tweak").on(t.userId, t.tweakId),
  ],
);
// Each get_report an AI read: its id and the tweak ids it served, so a memo
// saved after it records what was served without the AI reporting it.
export const servedReports = pgTable(
  "served_reports",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    tweakIds: text("tweak_ids").array().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    check("served_reports_tweaks", sql`cardinality(${t.tweakIds}) <= 10`),
  ],
);
// The person's own voice guide, append-only: the highest version is current,
// and every save carries the version it read.
export const coverSheets = pgTable(
  "cover_sheets",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    actorJson: text("actor_json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.version] }),
    check("cover_sheets_version", sql`${t.version} > 0`),
    check("cover_sheets_text", sql`char_length(${t.text}) <= 1500`),
    check(
      "cover_sheets_actor",
      sql`jsonb_typeof(${t.actorJson}::jsonb)='object'`,
    ),
  ],
);
// The account's "Keep memos" switch; no row reads as on.
export const memoSettings = pgTable("memo_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  keepMemos: boolean("keep_memos").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
