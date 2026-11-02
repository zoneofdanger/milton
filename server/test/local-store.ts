import { vector } from "@electric-sql/pglite-pgvector";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { SQL } from "drizzle-orm";
import { rmSync } from "node:fs";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDatabase } from "../src/store/database";

const migrationsFolder = new URL("../drizzle/", import.meta.url).pathname;

// A migration or rollback script, by path under server/drizzle.
export const drizzleSql = (path: string) =>
  Bun.file(migrationsFolder + path).text();

type Journal = { entries: { idx: number; tag: string }[] };
let journal: Promise<Journal> | undefined;
const readJournal = () =>
  (journal ??= Bun.file(migrationsFolder + "meta/_journal.json")
    .json()
    .then((value: Journal) => {
      // Rehearsals name migrations by number; the journal must agree.
      for (const [i, entry] of value.entries.entries())
        if (
          entry.idx !== i ||
          !entry.tag.startsWith(String(i).padStart(4, "0"))
        )
          throw new Error(`Journal entry ${i} is ${entry.tag}`);
      return value;
    }));

// A migrations folder whose journal ends at migration `idx`, so a rehearsal
// never runs migrations newer than the one it is about.
const folders = new Map<number, Promise<string>>();
export const migrationsThrough = (idx: number) => {
  let folder = folders.get(idx);
  if (!folder) {
    folder = (async () => {
      const all = await readJournal();
      if (!all.entries[idx]) throw new Error(`No migration ${idx}`);
      const entries = all.entries.slice(0, idx + 1);
      const dir = await mkdtemp(join(tmpdir(), `milton-through-${idx}-`));
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
      await mkdir(join(dir, "meta"));
      await Bun.write(
        join(dir, "meta/_journal.json"),
        JSON.stringify({ ...all, entries }),
      );
      for (const { tag } of entries)
        await copyFile(
          migrationsFolder + tag + ".sql",
          join(dir, tag + ".sql"),
        );
      return dir;
    })();
    folders.set(idx, folder);
  }
  return folder;
};

// Each migration runs once per test process: a checkpoint is the data directory
// after migration `idx`, built from the nearest earlier checkpoint.
const checkpoints = new Map<number, Promise<Blob | File>>();
const checkpoint = (idx: number) => {
  let dump = checkpoints.get(idx);
  if (!dump) {
    const earlier = Math.max(
      -1,
      ...[...checkpoints.keys()].filter((k) => k < idx),
    );
    dump = (async () => {
      const pg = await PGlite.create({
        ...(earlier >= 0
          ? { loadDataDir: await checkpoints.get(earlier) }
          : {}),
        extensions: { vector },
      });
      try {
        await migrate(drizzle(pg), {
          migrationsFolder: await migrationsThrough(idx),
        });
        return await pg.dumpDataDir("none");
      } finally {
        await pg.close();
      }
    })();
    checkpoints.set(idx, dump);
  }
  return dump;
};

// A new database with migrations 0000 through `idx` applied; close it after use.
export const migratedThrough = async (idx: number) =>
  PGlite.create({
    loadDataDir: await checkpoint(idx),
    extensions: { vector },
  });

// Milton's database interface over a local PGlite.
export function storeDatabase(pg: PGlite) {
  const orm = drizzle(pg);
  const db: StoreDatabase = {
    async query<Row extends Record<string, unknown>>(statement: SQL) {
      return (await orm.execute<Row>(statement)).rows as Row[];
    },
    transaction: (work) =>
      orm.transaction((tx) =>
        work({
          async query<Row extends Record<string, unknown>>(statement: SQL) {
            return (await tx.execute<Row>(statement)).rows as Row[];
          },
        }),
      ),
    withConnection: (work) => work(db),
  };
  return db;
}

// Same PostgreSQL schema and transaction rules, no network or environment secrets.
export async function localStore() {
  const pg = await migratedThrough((await readJournal()).entries.length - 1);
  const db = storeDatabase(pg);
  return {
    pg,
    db,
    env: { storeDatabase: db },
    async dispose() {
      await pg.close();
    },
  };
}
