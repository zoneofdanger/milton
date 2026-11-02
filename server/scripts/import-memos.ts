import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadMemos, parseMemo } from "../src/memos";
import { readLimits, StoreError, utf8Bytes } from "../src/store";
import {
  neonDatabase,
  type StoreDatabase,
  type StoreSession,
} from "../src/store/database";
import { importDatabaseUrl, verifyDatabaseTarget } from "./database-config";

export interface ImportSource {
  name: string;
  description: string;
  body: string;
  prefix: string;
  bytes: Uint8Array;
}
class ImportError extends Error {}

export function parseImportSource(name: string, text: string): ImportSource {
  const memo = parseMemo(name, text);
  const prefix = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)![0];
  return {
    name: memo.name,
    description: memo.description,
    body: text.slice(prefix.length),
    prefix,
    bytes: new TextEncoder().encode(text),
  };
}

export async function loadImportSources(
  directory: URL,
): Promise<ImportSource[]> {
  const memos = await loadMemos(directory);
  return Promise.all(
    memos.map(async (memo) => {
      const bytes = await readFile(new URL(`${memo.name}/SKILL.md`, directory));
      const source = parseImportSource(
        memo.name,
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      return { ...source, bytes };
    }),
  );
}

export function verifyImportedSource(
  source: ImportSource,
  committed: {
    name: string;
    description: string;
    body: string;
    prefix: string;
  },
) {
  if (
    committed.name !== source.name ||
    committed.description !== source.description ||
    committed.body !== source.body
  ) {
    throw new ImportError(
      `${source.name}: committed fields differ from parsed source.`,
    );
  }
  const rebuilt = new TextEncoder().encode(committed.prefix + committed.body);
  if (
    rebuilt.length !== source.bytes.length ||
    rebuilt.some((byte, index) => byte !== source.bytes[index])
  ) {
    throw new ImportError(
      `${source.name}: committed file bytes differ from source.`,
    );
  }
}

interface CommittedSource {
  source: ImportSource;
  memoId: string;
  version: number;
}
const importedDetails = z.object({
  kind: z.literal("import"),
  format: z.object({ prefix: z.string() }),
});

async function verifySnapshots(
  db: StoreSession,
  userId: string,
  committed: CommittedSource[],
) {
  const results: { name: string; version: number; bytes: number }[] = [];
  for (const { source, memoId, version } of committed) {
    const row = (
      await db.query<{
        name: string;
        description: string;
        body: string;
        details_json: string;
      }>(sql`
      SELECT r.name,v.description,v.body,v.details_json FROM memos r JOIN memo_versions v
      ON v.user_id = r.user_id AND v.memo_id = r.id JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ${userId} AND r.id = ${memoId} AND v.version = ${version} AND u.status = 'active'`)
    )[0];
    if (!row)
      throw new ImportError(
        `${source.name}: committed import snapshot is missing.`,
      );
    const details = importedDetails.parse(JSON.parse(row.details_json));
    verifyImportedSource(source, { ...row, prefix: details.format.prefix });
    results.push({ name: source.name, version, bytes: source.bytes.length });
  }
  return results;
}

export async function importMemos(
  db: StoreDatabase,
  userId: string,
  sources: ImportSource[],
  expected: ReadonlyMap<string, number>,
) {
  if (
    !/^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      userId,
    )
  )
    throw new ImportError("Use a Milton user id, not a provider subject.");
  const limits = await readLimits(db);
  if (new Set(sources.map((source) => source.name)).size !== sources.length)
    throw new ImportError("Duplicate source names.");
  for (const source of sources) {
    verifyImportedSource(
      source,
      parseImportSource(
        source.name,
        new TextDecoder("utf-8", { fatal: true }).decode(source.bytes),
      ),
    );
    if (
      utf8Bytes(source.name) > limits.name_bytes ||
      utf8Bytes(source.description) > limits.description_bytes ||
      utf8Bytes(source.body) > limits.body_bytes
    )
      throw new ImportError(
        `${source.name}: source exceeds a configured field byte limit.`,
      );
  }
  return db.withConnection(async (connection) => {
    const committed = await connection.transaction(async (tx) => {
      if (
        !(
          await tx.query(
            sql`SELECT id FROM users WHERE id = ${userId} AND status = 'active' FOR UPDATE`,
          )
        ).length
      )
        throw new ImportError("The import account is unavailable.");
      const committed: CommittedSource[] = [];
      for (const source of [...sources].sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        let memo = (
          await tx.query<{ id: string }>(
            sql`SELECT id FROM memos WHERE user_id = ${userId} AND name = ${source.name} FOR UPDATE`,
          )
        )[0];
        const head = memo
          ? ((
              await tx.query<{
                version: number | null;
              }>(sql`SELECT max(version)::integer AS version FROM memo_versions
          WHERE user_id = ${userId} AND memo_id = ${memo.id}`)
            )[0]!.version ?? 0)
          : 0;
        const expectedVersion =
          expected.get(source.name) ?? (memo ? undefined : 0);
        if (expectedVersion === undefined)
          throw new ImportError(
            `${source.name}: supply an explicit expected version before replacing an existing memo.`,
          );
        z.number().int().nonnegative().safe().parse(expectedVersion);
        if (head !== expectedVersion)
          throw new ImportError(
            `${source.name}: expected version conflicts with the current memo.`,
          );
        if (!memo)
          memo = (
            await tx.query<{ id: string }>(
              sql`INSERT INTO memos (user_id,name) VALUES (${userId},${source.name}) RETURNING id`,
            )
          )[0]!;
        await tx.query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json)
          VALUES (${userId},${memo.id},${head + 1},${source.description},${source.body},'Import existing memo',
          ${JSON.stringify({ kind: "system", id: "memo-import" })},${JSON.stringify({ kind: "import", format: { prefix: source.prefix } })})`);
        committed.push({ source, memoId: memo.id, version: head + 1 });
      }
      await verifySnapshots(tx, userId, committed);
      return committed;
    });
    // Same connection after COMMIT. A failed read-back never claims the transaction rolled back.
    try {
      return await verifySnapshots(connection, userId, committed);
    } catch {
      throw new ImportError(
        "Import committed, but post-commit verification failed. Read current versions before retrying.",
      );
    }
  });
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      user: { type: "string" },
      "expected-version": { type: "string", multiple: true },
      "database-url-file": { type: "string" },
      "source-dir": { type: "string" },
    },
  });
  if (!values.user)
    throw new ImportError(
      "Pass --user with an existing Milton id and expected versions for existing memos.",
    );
  const expected = new Map<string, number>();
  for (const value of values["expected-version"] ?? []) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)=(\d+)$/.exec(value);
    if (!match || expected.has(match[1]!))
      throw new ImportError(
        "Expected versions use distinct name=number entries.",
      );
    expected.set(match[1]!, Number(match[2]));
  }
  if (!values["source-dir"])
    throw new ImportError("Pass --source-dir with the memo folders to import.");
  const sources = await loadImportSources(
    pathToFileURL(resolve(values["source-dir"]) + "/"),
  );
  const url = await importDatabaseUrl(
    values["database-url-file"],
    process.env.DATABASE_URL,
  );
  const db = neonDatabase(url);
  await verifyDatabaseTarget(db);
  for (const result of await importMemos(db, values.user, sources, expected))
    console.log(
      `${result.name}: version ${result.version}, ${result.bytes} bytes, PASS`,
    );
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof ImportError
        ? error.message
        : error instanceof StoreError &&
            error.status >= 400 &&
            error.status < 500
          ? `${error.message} The import was rolled back.`
          : "Import failed or its outcome is unverified. Read current versions before retrying; no database details were logged.",
    );
    process.exitCode = 1;
  }
}
