import { expect, test } from "bun:test";
import {
  checkMigrations,
  updatedManifest,
  type Files,
  type Inputs,
} from "../../scripts/check-migrations";

// The guards CI runs as `bun scripts/check-migrations.ts`, on a fictional
// repository: one migration per track, as main holds it.: one migration per track, as main holds it.
const journal = (...entries: [tag: string, when: number][]) =>
  JSON.stringify({
    entries: entries.map(([tag, when], idx) => ({ idx, tag, when })),
  });
const mainFiles = (): Files =>
  new Map([
    ["server/drizzle/0000_baseline.sql", "CREATE TABLE t(id text);"],
    ["server/drizzle/meta/0000_snapshot.json", "{}"],
    ["server/drizzle/meta/_journal.json", journal(["0000_baseline", 100])],
    ["server/migrations/001-roles.sql", "GRANT SELECT ON t TO r;"],
    ["apps/auth/migrations/001-native.up.sql", "CREATE TABLE n(id text);"],
  ]);
const main = () => {
  const files = mainFiles();
  const manifest = updatedManifest({ files, manifest: "", authMigrations: [] });
  return {
    files,
    manifest,
    subjects: ["Merge agent/x: stop reading t.id (#40)"],
  };
};
/** A branch of main changed by `edit`, checked against main. */
const branch = (edit: (files: Files) => void, withBase = true) => {
  const base = main();
  const files = new Map(base.files);
  edit(files);
  const inputs: Inputs = {
    files,
    manifest: base.manifest,
    authMigrations: ["001-native"],
    base: withBase ? base : undefined,
  };
  return { inputs, failures: () => checkMigrations(inputs) };
};
/** The same, after the documented update command locks the branch's files. */
const locked = (edit: (files: Files) => void) => {
  const b = branch(edit);
  b.inputs.manifest = updatedManifest(b.inputs);
  return checkMigrations(b.inputs);
};

test("released migrations are locked: an edit, rename or unlisted file fails with what to do", () => {
  expect(branch(() => {}).failures()).toEqual([]);
  expect(branch(() => {}, false).failures()).toEqual([]);
  const edited = (files: Files) =>
    files.set("server/migrations/001-roles.sql", "GRANT ALL ON t TO r;");
  expect(branch(edited).failures()).toContain(
    "released migration server/migrations/001-roles.sql changed since main; restore it and add a new migration instead",
  );
  // Without origin/main the manifest still catches it.
  expect(branch(edited, false).failures()).toEqual([
    "released migration server/migrations/001-roles.sql changed; restore it and add a new migration instead",
  ]);
  // Re-hashing the edited file in the manifest does not hide it from main.
  const rehashed = branch(edited);
  rehashed.inputs.manifest = rehashed.inputs.manifest.replace(
    /^\w+(?= {2}server\/migrations\/001-roles\.sql)/m,
    "0".repeat(64),
  );
  expect(rehashed.failures()).toContain(
    "scripts/released-migrations.sha256: main's line for server/migrations/001-roles.sql was changed or removed; restore it (released migrations never change)",
  );
  // The update command never re-locks it, even before main has a manifest.
  const bootstrap = branch(edited);
  for (const manifest of [bootstrap.inputs.base!.manifest, undefined]) {
    bootstrap.inputs.base!.manifest = manifest;
    expect(() => updatedManifest(bootstrap.inputs)).toThrow(
      "released migration server/migrations/001-roles.sql changed or is missing",
    );
  }
  expect(
    branch((files) => {
      files.set(
        "server/migrations/002-roles.sql",
        files.get("server/migrations/001-roles.sql")!,
      );
      files.delete("server/migrations/001-roles.sql");
    }).failures(),
  ).toEqual(
    expect.arrayContaining([
      "released migration server/migrations/001-roles.sql was renamed or removed since main; restore it and add a new migration instead",
      "server/migrations/002-roles.sql is not in scripts/released-migrations.sha256; lock it: bun scripts/check-migrations.ts --update",
    ]),
  );
  // A new migration passes once the documented command locks it.
  const added = (files: Files) =>
    files.set("server/migrations/002-grants.sql", "GRANT SELECT ON t TO s;");
  expect(branch(added).failures()).toEqual([
    "server/migrations/002-grants.sql is not in scripts/released-migrations.sha256; lock it: bun scripts/check-migrations.ts --update",
  ]);
  expect(locked(added)).toEqual([]);
});

test("a new migration is numbered above main's highest, and the journal runs in order", () => {
  expect(
    locked((files) => files.set("server/migrations/001-more.sql", "SELECT 1;")),
  ).toEqual([
    "server/migrations/001-more.sql is numbered 1, not above main's highest in server/migrations (1); renumber it 2 or later",
  ]);
  expect(
    locked((files) => {
      files.set("apps/auth/migrations/002-a.up.sql", "SELECT 1;");
      files.set("apps/auth/migrations/002-b.up.sql", "SELECT 1;");
    }),
  ).toContain(
    "apps/auth/migrations/002-a.up.sql and apps/auth/migrations/002-b.up.sql share number 2; give each new migration its own number",
  );
  // A native migration the runner's .up.sql listing would never see.
  expect(
    locked((files) =>
      files.set("apps/auth/migrations/002-next.sql", "SELECT 1;"),
    ),
  ).toEqual([
    "apps/auth/migrations/002-next.sql is not named NNN-name.up.sql; rename it",
  ]);
  // The native migrator applies only listed files.
  expect(
    locked((files) =>
      files.set("apps/auth/migrations/002-a.up.sql", "SELECT 1;"),
    ),
  ).toEqual([
    "apps/auth/scripts/migrations.ts: AUTH_MIGRATIONS must list every apps/auth/migrations/*.up.sql in order (001-native, 002-a); the migrator applies only listed files",
  ]);
  const generated =
    (when: number, tag = "0001_next") =>
    (files: Files) => {
      files.set(`server/drizzle/${tag}.sql`, "SELECT 1;");
      files.set(`server/drizzle/meta/${tag.slice(0, 4)}_snapshot.json`, "{}");
      files.set(
        "server/drizzle/meta/_journal.json",
        journal(["0000_baseline", 100], [tag, when]),
      );
    };
  expect(locked(generated(101))).toEqual([]);
  expect(locked(generated(100))).toEqual([
    "server/drizzle/meta/_journal.json: 0001_next's when (100) is not after 0000_baseline's (100); migration timestamps must strictly increase",
  ]);
  expect(locked(generated(101, "0002_skip"))).toContain(
    "server/drizzle/meta/_journal.json: entry 1 has idx 1 and tag 0002_skip; idx and tag run 0, 1, 2… without gaps (regenerate with db:generate)",
  );
  expect(
    locked((files) =>
      files.set(
        "server/drizzle/meta/_journal.json",
        journal(["0000_baseline", 99]),
      ),
    ),
  ).toEqual([
    "server/drizzle/meta/_journal.json: main's entry 0 (0000_baseline) changed or is missing; journal entries on main never change",
  ]);
});

test("a migration that drops or renames needs a merged code-stopped-by PR", () => {
  const drop = (header: string, statement = "ALTER TABLE t DROP COLUMN id;") =>
    locked((files) =>
      files.set("server/migrations/002-drop.sql", `${header}\n${statement}\n`),
    );
  expect(
    drop("-- Grants only. Never DROP TABLE t.", "GRANT SELECT ON t TO s;"),
  ).toEqual([]);
  expect(drop("-- No header.")).toEqual([
    'server/migrations/002-drop.sql drops or renames a table or column ("DROP COLUMN"); add a line "-- code-stopped-by: #NN" naming the merged PR that stopped all code using it, and release that code first',
  ]);
  for (const statement of [
    "DROP TABLE t;",
    "ALTER TABLE t DROP id;",
    "ALTER TABLE t RENAME COLUMN id TO key;",
  ])
    expect(drop("", statement)).toHaveLength(1);
  expect(
    drop(
      "",
      "ALTER TABLE t ALTER COLUMN id DROP NOT NULL; ALTER TABLE t DROP CONSTRAINT c;",
    ),
  ).toEqual([]);
  // Comments and strings neither hide a statement nor fake one.
  for (const statement of [
    "DROP/**/TABLE t;",
    "SELECT '--'; DROP TABLE t;",
    "SELECT E'\\'--'; DROP TABLE t;",
    "TRUNCATE t;",
    "ALTER TYPE pair DROP ATTRIBUTE label;",
  ])
    expect(drop("", statement)).toHaveLength(1);
  expect(
    drop(
      "",
      `SELECT 'DROP TABLE t', $x$ DROP TABLE t $x$, "drop table"; CREATE TRIGGER g BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f(); GRANT EXECUTE ON FUNCTION f() TO r;`,
    ),
  ).toEqual([]);
  expect(
    drop("", "SELECT $$ -- code-stopped-by: #40\n$$; DROP TABLE t;"),
  ).toHaveLength(1);
  // Dynamic SQL is unreadable here, so it fails closed until a line says what it does.
  const dynamic = "DO $$ BEGIN EXECUTE 'DR' || 'OP TABLE t'; END $$;";
  expect(drop("", dynamic)).toEqual([
    'server/migrations/002-drop.sql runs dynamic SQL ("DO"), which this check cannot read; add "-- code-stopped-by: #NN" if it drops or renames a table or column, or "-- no-drop-or-rename: <reason>" if it does not',
  ]);
  expect(drop("-- no-drop-or-rename: grants only", dynamic)).toEqual([]);
  expect(drop("-- code-stopped-by: #40", dynamic)).toEqual([]);
  expect(
    drop("-- no-drop-or-rename: says so, but drops", "DROP TABLE t;"),
  ).toHaveLength(1);
  expect(drop("-- code-stopped-by: #41")).toEqual([
    "server/migrations/002-drop.sql names #41 in code-stopped-by, but no commit on main merges #41; merge and release that PR before this migration",
  ]);
  expect(drop("-- code-stopped-by: #40")).toEqual([]);
});
