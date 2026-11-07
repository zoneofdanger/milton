import type { SampleContext } from "./sample-context";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  date,
  primaryKey,
  unique,
  uniqueIndex,
  foreignKey,
  index,
  check,
  customType,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
// Changing this default needs a migration. The card version guard also reads
// reason_bytes; application code reads the other four limits.
const limits = {
  body_bytes: 131072,
  description_bytes: 500,
  reason_bytes: 500,
  report_body_bytes: 262144,
  daily_calls: 10000,
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
// One-way sha256("provider:subject") of each deleted sign-in identity. No longer
// written or read: trial-eligibility fingerprints alone refuse a second trial.
// Kept until a later migration, released after this code, drops it.
export const deletedIdentities = pgTable(
  "deleted_identities",
  {
    identityHash: text("identity_hash").primaryKey(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("deleted_identities_hash", sql`${t.identityHash} ~ '^[a-f0-9]{64}$'`),
  ],
);
export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dayUtc: date("day_utc").notNull(),
    toolCalls: integer("tool_calls").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.dayUtc] }),
    check("usage_nonnegative", sql`${t.toolCalls} >= 0`),
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
    sourceHash: text("source_hash").notNull(),
    // Written once, with the save's outcome, in the save's transaction.
    result: jsonb("result_json").notNull(),
    createdAt: createdAt(),
    payloadBytes: bigint("payload_bytes", { mode: "number" })
      .notNull()
      .generatedAlwaysAs(
        sql`octet_length(request_id)::bigint + octet_length(input_hash) + octet_length(source_hash) + 2048 + 128`,
      ),
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

// Stable instruction identities and append-only, account-scoped content history.
export const instructionCards = pgTable(
  "instruction_cards",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    // TPS order. Assigned once at insert, in insertion order.
    position: bigint("position", { mode: "number" })
      .notNull()
      .default(sql`nextval('instruction_card_position')`),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "instruction_cards_pkey", columns: [t.userId, t.id] }),
    foreignKey({
      name: "instruction_cards_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    unique("instruction_cards_position").on(t.userId, t.position),
    check("card_id_nonempty", sql`${t.id} <> ''`),
  ],
);
export const instructionCardVersions = pgTable(
  "instruction_card_versions",
  {
    userId: text("user_id").notNull(),
    cardId: text("card_id").notNull(),
    version: integer("version").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    archived: boolean("archived").notNull().default(false),
    // Where this version files the rule: one of the five reports or 'cover', the
    // cover sheet. A move is a new version.
    report: text("report").notNull(),
    reason: text("reason").notNull(),
    actorJson: text("actor_json").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    payloadBytes: bigint("payload_bytes", { mode: "number" })
      .notNull()
      .generatedAlwaysAs(
        sql`octet_length(description)::bigint + octet_length(body) + octet_length(reason) + octet_length(actor_json) + octet_length(details_json)`,
      ),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: "instruction_card_versions_pkey",
      columns: [t.userId, t.cardId, t.version],
    }),
    foreignKey({
      name: "instruction_card_versions_user_id_card_id_fkey",
      columns: [t.userId, t.cardId],
      foreignColumns: [instructionCards.userId, instructionCards.id],
    }).onDelete("cascade"),
    check("instruction_card_versions_version_check", sql`${t.version} > 0`),
    check(
      "instruction_card_versions_description_check",
      sql`${t.description} <> '' AND position(chr(10) in ${t.description})=0 AND position(chr(13) in ${t.description})=0`,
    ),
    check(
      "instruction_card_versions_actor_json_check",
      sql`jsonb_typeof(${t.actorJson}::jsonb)='object'`,
    ),
    check(
      "instruction_card_versions_details_json_check",
      sql`jsonb_typeof(${t.detailsJson}::jsonb)='object'`,
    ),
    check(
      "instruction_card_versions_report",
      sql`${t.report} IN ('cover','email','chat','post','document','speech')`,
    ),
  ],
);
// A stable, named kind of sample within one report. Labels are unique per
// report regardless of case and never change; rows leave only with their
// account.
export const sampleKinds = pgTable(
  "sample_kinds",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    report: text("report").notNull(),
    // Free-form label chosen by the filing assistant ("follow-up email").
    label: text("label").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    unique("sample_kinds_report_key").on(t.userId, t.id, t.report),
    uniqueIndex("sample_kinds_label").on(
      t.userId,
      t.report,
      sql`lower(${t.label})`,
    ),
    check(
      "sample_kinds_report",
      sql`${t.report} IN ('email','chat','post','document','speech')`,
    ),
    check(
      "sample_kinds_label_check",
      sql`char_length(${t.label}) BETWEEN 1 AND 60 AND position(chr(10) in ${t.label})=0 AND position(chr(13) in ${t.label})=0 AND btrim(${t.label})=${t.label}`,
    ),
  ],
);

// One stable sample identity; every approved change is a complete immutable version.
export const samples = pgTable(
  "samples",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    createdAt: createdAt(),
    clientJson: text("client_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    check("samples_id", sql`${t.id} <> ''`),
    check(
      "samples_client_object",
      sql`jsonb_typeof(${t.clientJson}::jsonb)='object'`,
    ),
  ],
);
export const sampleVersions = pgTable(
  "sample_versions",
  {
    userId: text("user_id").notNull(),
    sampleId: text("sample_id").notNull(),
    version: integer("version").notNull(),
    report: text("report").notNull(),
    kindId: text("kind_id").notNull(),
    context: jsonb("context").$type<SampleContext>().notNull(),
    body: text("body").notNull(),
    retired: boolean("retired").notNull().default(false),
    retireReason: text("retire_reason"),
    actorJson: text("actor_json").notNull(),
    requestId: text("request_id"),
    // Exact known legacy provenance only; no reconstructed missing contexts.
    provenance: jsonb("provenance")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, (context->>'summary') || ' ' || body)`,
    ),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.sampleId, t.version] }),
    foreignKey({
      name: "sample_versions_sample_fk",
      columns: [t.userId, t.sampleId],
      foreignColumns: [samples.userId, samples.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "sample_versions_kind_fk",
      columns: [t.userId, t.kindId, t.report],
      foreignColumns: [sampleKinds.userId, sampleKinds.id, sampleKinds.report],
    }).onDelete("cascade"),
    check("sample_versions_version", sql`${t.version} > 0`),
    check(
      "sample_versions_report",
      sql`${t.report} IN ('email','chat','post','document','speech')`,
    ),
    check(
      "sample_versions_context",
      sql`public.milton_sample_context_valid(${t.context})`,
    ),
    check(
      "sample_versions_body",
      sql`btrim(${t.body}) <> '' AND octet_length(${t.body}) <= 131072`,
    ),
    check(
      "sample_versions_actor",
      sql`jsonb_typeof(${t.actorJson}::jsonb)='object'`,
    ),
    check(
      "sample_versions_provenance",
      sql`jsonb_typeof(${t.provenance})='object'`,
    ),
    check(
      "sample_versions_retirement",
      sql`(${t.retireReason} IS NOT NULL) = ${t.retired} AND (${t.retireReason} IS NULL OR ${t.retireReason} IN ('replaced','removed','evicted'))`,
    ),
  ],
);

// Durable evidence of accepted instruction changes, independent of expiring jobs.
export const acceptedChanges = pgTable(
  "accepted_changes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    operation: text("operation").notNull(),
    request: jsonb("request_json").notNull(),
    actor: jsonb("actor_json").notNull(),
    transformation: jsonb("transformation_json").notNull(),
    affected: jsonb("affected_json").notNull(),
    beforeTps: text("before_tps").notNull(),
    afterTps: text("after_tps").notNull(),
    beforeSource: text("before_source").notNull(),
    afterSource: text("after_source").notNull(),
    createdAt: createdAt(),
    payloadBytes: bigint("payload_bytes", { mode: "number" })
      .notNull()
      .generatedAlwaysAs(
        sql`octet_length(request_id)::bigint + octet_length(operation) + octet_length(request_json::text) + octet_length(actor_json::text) + octet_length(transformation_json::text) + octet_length(affected_json::text) + octet_length(before_tps) + octet_length(after_tps) + octet_length(before_source) + octet_length(after_source) + 128`,
      ),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.requestId] }),
    check(
      "accepted_change_shape",
      sql`length(${t.requestId})=36 AND ${t.operation} IN ('save_memo','refinement_apply') AND jsonb_typeof(${t.request})='object' AND jsonb_typeof(${t.actor})='object' AND jsonb_typeof(${t.transformation})='object' AND jsonb_typeof(${t.affected})='array' AND jsonb_array_length(${t.affected})<=1100`,
    ),
    check(
      "accepted_change_hashes",
      sql`${t.beforeTps} ~ '^[a-f0-9]{64}$' AND ${t.afterTps} ~ '^[a-f0-9]{64}$' AND ${t.beforeSource} ~ '^[a-f0-9]{64}$' AND ${t.afterSource} ~ '^[a-f0-9]{64}$'`,
    ),
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

// Derived guides are separate from approved-source versions and size limits.
export const guideAccounts = pgTable(
  "guide_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    epoch: integer("epoch").notNull().default(0),
    optedInAt: timestamp("opted_in_at", { withTimezone: true }),
    optInReference: text("opt_in_reference"),
  },
  (t) => [
    check(
      "guide_consent",
      sql`NOT ${t.enabled} OR (${t.optedInAt} IS NOT NULL AND ${t.optInReference} IS NOT NULL)`,
    ),
  ],
);
export const reportGuides = pgTable(
  "report_guides",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    report: text("report").notNull(),
    sourceVersion: integer("source_version").notNull().default(0),
    completedVersion: integer("completed_version"),
    guideText: text("guide_text"),
    status: text("status").notNull().default("empty"),
    reason: text("reason").notNull().default("no_samples"),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.report] }),
    check(
      "guide_report",
      sql`${t.report} IN ('email','chat','post','document','speech')`,
    ),
    check(
      "guide_versions",
      sql`${t.sourceVersion} >= 0 AND (${t.completedVersion} IS NULL OR ${t.completedVersion} <= ${t.sourceVersion})`,
    ),
    check("guide_attempts", sql`${t.attempts} BETWEEN 0 AND 2`),
    check(
      "guide_text_limit",
      sql`${t.guideText} IS NULL OR char_length(${t.guideText}) <= 6000`,
    ),
    check(
      "guide_status",
      sql`${t.status} IN ('empty','queued','running','ready','insufficient','failed','unavailable')`,
    ),
  ],
);
// Content-free reservations intentionally outlive accounts; deletion cannot reset caps.
export const guideSpend = pgTable(
  "guide_spend",
  {
    id: text("id").primaryKey(),
    accountKey: text("account_key").notNull(),
    amountMicros: integer("amount_micros").notNull(),
    settled: boolean("settled").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    check("guide_spend_amount", sql`${t.amountMicros} >= 0`),
    index("guide_spend_date").on(t.createdAt),
  ],
);
export const guideBudgetLock = pgTable(
  "guide_budget_lock",
  {
    singleton: integer("singleton").primaryKey(),
  },
  (t) => [check("guide_budget_singleton", sql`${t.singleton} = 1`)],
);
