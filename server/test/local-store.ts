import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { SQL } from "drizzle-orm";
import type { StoreDatabase } from "../src/store/database";

const migrationsFolder = new URL("../drizzle/", import.meta.url).pathname;
let dump: Promise<Blob | File> | undefined;
const checkpoint = () =>
  (dump ??= (async () => {
    const { entries } = (await Bun.file(
      migrationsFolder + "meta/_journal.json",
    ).json()) as { entries: { when: number }[] };
    for (let i = 1; i < entries.length; i++)
      if (entries[i]!.when <= entries[i - 1]!.when)
        throw new Error("Migration timestamps must strictly increase.");
    const pg = new PGlite();
    try {
      await migrate(drizzle(pg), { migrationsFolder });
      return await pg.dumpDataDir("none");
    } finally {
      await pg.close();
    }
  })());

// How many transactions are open on any local store in this process, so a fake
// Stripe can record a call made inside one.
let open = 0;
export const openTransactions = () => open;

// Milton's database interface over a local PGlite.
export function storeDatabase(pg: PGlite) {
  const orm = drizzle(pg);
  const db: StoreDatabase = {
    async query<Row extends Record<string, unknown>>(statement: SQL) {
      return (await orm.execute<Row>(statement)).rows as Row[];
    },
    transaction: async (work) => {
      open++;
      try {
        return await orm.transaction((tx) =>
          work({
            async query<Row extends Record<string, unknown>>(statement: SQL) {
              return (await tx.execute<Row>(statement)).rows as Row[];
            },
          }),
        );
      } finally {
        open--;
      }
    },
    withConnection: (work) => work(db),
  };
  return db;
}

// Same PostgreSQL schema and transaction rules, no network or environment secrets.
export async function localStore() {
  const pg = await PGlite.create({ loadDataDir: await checkpoint() });
  const db = storeDatabase(pg);
  return {
    pg,
    db,
    env: { storeDatabase: db, appOrigin: "http://localhost:3001" },
    async dispose() {
      await pg.close();
    },
  };
}
