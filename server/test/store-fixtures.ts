import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import type { SampleContext } from "../src/store/sample-context";
import type { ReportId } from "../src/store/reports";
import { compiledMemos } from "../src/store/compiled";
import type { StoreDatabase, StoreSession } from "../src/store/database";
import { cardHeadsJson, type CardHead } from "../src/store/cards";
import { eraseAccountRows } from "../src/store/accounts";

// Every card's head version, in position order.
export async function cardHeads(tx: StoreSession, userId: string) {
  return (
    await tx.query<{ heads: CardHead[] }>(
      sql`SELECT (${cardHeadsJson(userId)}) AS heads`,
    )
  )[0]!.heads;
}

// Runs `inside` at the start of every transaction, while it is open. A request
// started meanwhile waits for it, as on the account lock.
export const insideTransactions = (
  db: StoreDatabase,
  inside: () => Promise<unknown>,
): StoreDatabase => ({
  ...db,
  transaction: (work) =>
    db.transaction(async (tx) => {
      await inside();
      return work(tx);
    }),
});

// The erasure step of account deletion (auth-lifecycle.ts) for a sign-in
// identity: the row lock every writer takes, then the same erasure.
// Trial-eligibility fingerprints outlive it.
export const eraseAccount = (
  db: StoreDatabase,
  identity: { provider: string; subject: string },
) =>
  db.transaction(async (tx) => {
    const [account] = await tx.query<{ id: string }>(sql`
      SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
      WHERE i.provider=${identity.provider} AND i.subject=${identity.subject}
        AND u.status='active' FOR UPDATE OF u`);
    await eraseAccountRows(tx, account!.id);
  });

// The JSON payload of an MCP tool result.
export const read = (result: { content: [{ text: string }] }) =>
  JSON.parse(result.content[0].text);

// Bare accounts: one users row per id.
export const seedUsers = (pg: PGlite, ...ids: string[]) =>
  pg.query(
    `INSERT INTO users(id) VALUES ${ids.map((_, i) => `($${i + 1})`).join(",")}`,
    ids,
  );

// A user's store as a fixture assistant sees it.
export const fixtureStore = (
  db: StoreDatabase,
  userId: string,
  clientId = "fixture",
) => compiledMemos(db, userId, { issuer: "fixture", clientId });

// One current rule, with a stable identity and its first immutable version.
export const seedRule = async (
  pg: PGlite,
  userId: string,
  id: string,
  body: string,
  options: {
    description?: string;
    report?: ReportId | "cover";
    archived?: boolean;
  } = {},
) => {
  await pg.query("INSERT INTO instruction_cards(user_id,id) VALUES ($1,$2)", [
    userId,
    id,
  ]);
  await pg.query(
    `INSERT INTO instruction_card_versions(user_id,card_id,version,description,body,report,archived,reason,actor_json)
    VALUES ($1,$2,1,$3,$4,$5,$6,'Fixture','{}')`,
    [
      userId,
      id,
      options.description ?? "Fictional instruction",
      body,
      options.report ?? "cover",
      options.archived ?? false,
    ],
  );
};

// An approved sample's identity plus immutable snapshots, with fictional provenance.
export async function seedSample(
  pg: PGlite,
  userId: string,
  id: string,
  report: ReportId,
  kindId: string,
  context: SampleContext,
  body: string,
  options: { createdAt?: string; retired?: boolean } = {},
) {
  await pg.query(
    "INSERT INTO samples(user_id,id,client_json,created_at) VALUES ($1,$2,'{}',coalesce($3::timestamptz,clock_timestamp()))",
    [userId, id, options.createdAt ?? null],
  );
  await pg.query(
    `INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,actor_json,request_id,created_at)
    VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,'{}',$7,coalesce($8::timestamptz,clock_timestamp()))`,
    [
      userId,
      id,
      report,
      kindId,
      JSON.stringify(context),
      body,
      crypto.randomUUID(),
      options.createdAt ?? null,
    ],
  );
  if (options.retired)
    await pg.query(
      `INSERT INTO sample_versions(user_id,sample_id,version,report,kind_id,context,body,retired,retire_reason,actor_json,request_id)
      SELECT user_id,sample_id,2,report,kind_id,context,body,true,'removed','{}',$3 FROM sample_versions WHERE user_id=$1 AND sample_id=$2`,
      [userId, id, crypto.randomUUID()],
    );
}
