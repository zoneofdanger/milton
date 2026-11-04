import type { PGlite } from "@electric-sql/pglite";
import type { ReportId } from "../src/store/reports";
import { compiledMemos } from "../src/store/compiled";
import type { StoreDatabase, StoreSession } from "../src/store/database";

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
