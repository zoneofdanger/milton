/** Migration guards for the three migration tracks, run by CI on every pull request:
 *
 *   bun scripts/check-migrations.ts            check
 *   bun scripts/check-migrations.ts --update   lock this branch's new migrations
 *
 * 1. Numbering: a migration new on this branch is numbered above main's highest in
 *    its track, with a number of its own; the Drizzle journal's idx/tag run 0..n
 *    with strictly increasing `when`, and main's entries never change.
 * 2. Lock: scripts/released-migrations.sha256 holds the SHA-256 of every migration
 *    file (Drizzle snapshots included, the growing journal excepted). A file on main
 *    never changes, moves or disappears, and neither does its line.
 * 3. Drop order: a new migration that drops, truncates or renames a table, column,
 *    view, schema, type or function carries a
 *    `-- code-stopped-by: #NN` line naming the merged PR that stopped all code using
 *    it (AGENTS.md: release the code first).
 *
 * "Main" is the merge base with origin/main. Without origin/main (a local clone
 * that never fetched it) only the lock and journal are checked, and this says so;
 * in CI that is a failure. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_MIGRATIONS } from "../apps/auth/scripts/migrations.ts";

export const MANIFEST = "scripts/released-migrations.sha256";
export const UPDATE = "bun scripts/check-migrations.ts --update";
const JOURNAL = "server/drizzle/meta/_journal.json";
export const TRACKS = [
  {
    dir: "server/drizzle",
    name: /^(\d{4})_[a-z0-9_]+\.sql$/,
    form: "NNNN_name.sql",
  },
  {
    dir: "server/migrations",
    name: /^(\d{3})-[a-z0-9-]+(?:\.up)?\.sql$/,
    form: "NNN-name.sql or NNN-name.up.sql",
  },
  // The runner applies only listed .up.sql files; the 000 prerequisites file on
  // main predates this rule and is never run by it.
  {
    dir: "apps/auth/migrations",
    name: /^(\d{3})-[a-z0-9-]+\.up\.sql$/,
    form: "NNN-name.up.sql",
  },
];
// Statements that remove or rename something running code may still read, matched
// per statement after sqlCode; DROP CONSTRAINT/DEFAULT/NOT NULL and the like pass.
// Drops and renames cover the same objects: tables, columns, views, schemas,
// types (their attributes and enum values) and functions.
const OBJECTS =
  "TABLE|VIEW|MATERIALIZED\\s+VIEW|FOREIGN\\s+TABLE|SCHEMA|TYPE|DOMAIN|FUNCTION|PROCEDURE|ROUTINE";
const DESTRUCTIVE = [
  new RegExp(`^DROP\\s+(?:${OBJECTS})\\b`, "i"),
  /^TRUNCATE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /^ALTER\s+(?:FOREIGN\s+)?TABLE\b.*?\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\b|EXPRESSION\b|IDENTITY\b)[A-Za-z_"]/i,
  /^ALTER\s+TYPE\b.*\bDROP\s+(?:ATTRIBUTE|VALUE)\b/i,
  // Index, sequence, trigger and constraint renames pass.
  new RegExp(
    `^ALTER\\s+(?:${OBJECTS})\\b.*\\bRENAME\\b(?!\\s+CONSTRAINT\\b)`,
    "i",
  ),
];
// Dynamic SQL this check cannot read: a DO block, or EXECUTE other than a
// trigger's EXECUTE FUNCTION or the EXECUTE privilege.
const DYNAMIC = [/^DO\b/i, /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)/i];
const STOPPED_BY = /^--\s*code-stopped-by:\s*(#\d+(?:\s*,\s*#\d+)*)\s*$/m;
const NO_DROP = /^--\s*no-drop-or-rename:\s*\S/m;
const DOLLAR = /^\$(?:[A-Za-z_]\w*)?\$/;

/** The statements of `text` with every comment as a space, every string literal
 * (quoted, E'', dollar-quoted) as '' and every quoted identifier as "q", so only
 * real SQL is matched; and its line comments, where the headers live. */
export function sqlCode(text: string) {
  const statements: { code: string; bodies: string[] }[] = [];
  let code = "",
    bodies: string[] = [],
    comments = "",
    i = 0;
  const skipTo = (close: string, from: number) => {
    const end = text.indexOf(close, from);
    return end < 0 ? text.length : end + close.length;
  };
  const end = () => {
    const statement = code.replace(/\s+/g, " ").trim();
    if (statement) statements.push({ code: statement, bodies });
    code = "";
    bodies = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    const word = /\w/.test(text[i - 1] ?? "");
    if (text.startsWith("--", i)) {
      const end = skipTo("\n", i);
      comments += text.slice(i, end).trimEnd() + "\n";
      code += " ";
      i = end;
    } else if (text.startsWith("/*", i)) {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      do {
        if (text.startsWith("/*", i)) (depth++, (i += 2));
        else if (text.startsWith("*/", i)) (depth--, (i += 2));
        else i++;
      } while (depth > 0 && i < text.length);
      code += " ";
    } else if (c === "'") {
      const escapes =
        /[eE]/.test(text[i - 1] ?? "") && !/\w/.test(text[i - 2] ?? "");
      const start = i + 1;
      for (i++; i < text.length; i++)
        if (escapes && text[i] === "\\") i++;
        else if (text[i] === "'" && text[i + 1] === "'") i++;
        else if (text[i] === "'") break;
      bodies.push(text.slice(start, i).replaceAll("''", "'"));
      i++;
      code += "''";
    } else if (c === '"') {
      for (i++; i < text.length; i++)
        if (text[i] === '"' && text[i + 1] === '"') i++;
        else if (text[i] === '"') break;
      i++;
      code += '"q"';
    } else if (c === "$" && !word && DOLLAR.test(text.slice(i))) {
      const tag = DOLLAR.exec(text.slice(i))![0];
      const start = i + tag.length;
      i = skipTo(tag, start);
      bodies.push(text.slice(start, Math.max(start, i - tag.length)));
      code += "''";
    } else if (c === ";") {
      end();
      i++;
    } else {
      code += c;
      i++;
    }
  }
  end();
  return { statements, comments };
}

// Statements whose string bodies are SQL: function and procedure bodies, DO
// blocks and EXECUTE arguments (a RAISE message, say, is not).
const BODIES =
  /^(?:CREATE(?:\s+OR\s+REPLACE)?\s+(?:FUNCTION|PROCEDURE)|DO)\b|\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)/i;

// In a PL/pgSQL body a statement may follow BEGIN, THEN, LOOP and the like, so
// the same patterns match anywhere in it.
const IN_BODY = DESTRUCTIVE.map(
  (re) => new RegExp(re.source.replace(/^\^/, "\\b"), "i"),
);

/** The first drop, truncate or rename inside those bodies, read the same way. */
export function bodyFinding(
  statements: { code: string; bodies: string[] }[],
): string | undefined {
  for (const { code, bodies } of statements)
    if (BODIES.test(code))
      for (const body of bodies) {
        const inner = sqlCode(body).statements;
        const found =
          inner
            .flatMap((s) => IN_BODY.map((re) => re.exec(s.code)?.[0]))
            .find(Boolean) ?? bodyFinding(inner);
        if (found) return found;
      }
  return undefined;
}

/** path → file text, for every file under the three track directories. */
export type Files = Map<string, string>;
export type Inputs = {
  files: Files;
  manifest: string;
  authMigrations: readonly string[];
  /** Main (the merge base): its files, its manifest and its commit subjects. */
  base?: { files: Files; manifest: string | undefined; subjects: string[] };
};

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const locked = (path: string) => path !== JOURNAL;
const trackOf = (path: string) =>
  TRACKS.find(
    (t) =>
      path.startsWith(t.dir + "/") &&
      !path.slice(t.dir.length + 1).includes("/"),
  );
const numberOf = (path: string) =>
  Number(trackOf(path)?.name.exec(path.split("/").pop()!)?.[1] ?? NaN);

/** The manifest as path → hash; malformed lines are reported. */
export function parseManifest(text: string, failures: string[] = []) {
  const entries = new Map<string, string>();
  for (const line of text.split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (m) entries.set(m[2]!, m[1]!);
    else
      failures.push(
        `${MANIFEST}: malformed line "${line}"; expect "<sha256>  <path>". Regenerate: ${UPDATE}`,
      );
  }
  return entries;
}

/** The manifest this branch should hold: main's entries kept as they are, every
 * other migration file hashed fresh. Refuses while a released file differs. */
export function updatedManifest({ files, manifest, base }: Inputs) {
  const released = parseManifest(base ? (base.manifest ?? "") : manifest);
  const lines = [...files.keys()]
    .filter(locked)
    .sort()
    .map(
      (path) => `${released.get(path) ?? sha256(files.get(path)!)}  ${path}`,
    );
  const changed = [
    ...[...released].filter(
      ([path, hash]) =>
        files.get(path) === undefined || sha256(files.get(path)!) !== hash,
    ),
    ...[...(base?.files ?? [])].filter(
      ([path, text]) => locked(path) && files.get(path) !== text,
    ),
  ];
  if (changed[0])
    throw new Error(
      `released migration ${changed[0][0]} changed or is missing; restore it before updating ${MANIFEST}`,
    );
  return lines.join("\n") + "\n";
}

/** Every failure, each naming the file and what to do. Empty means pass. */
export function checkMigrations({
  files,
  manifest,
  authMigrations,
  base,
}: Inputs) {
  const failures: string[] = [];
  const fail = (message: string) =>
    failures.includes(message) || failures.push(message);
  const entries = parseManifest(manifest, failures);
  const baseEntries = parseManifest(base?.manifest ?? "");
  const isNew = (path: string) =>
    base ? !base.files.has(path) : !entries.has(path);

  // 2. The lock.
  for (const [path, text] of base?.files ?? [])
    if (locked(path) && files.get(path) !== text)
      fail(
        `released migration ${path} ${files.has(path) ? "changed" : "was renamed or removed"} since main; restore it and add a new migration instead`,
      );
  for (const [path, hash] of baseEntries)
    if (entries.get(path) !== hash)
      fail(
        `${MANIFEST}: main's line for ${path} was changed or removed; restore it (released migrations never change)`,
      );
  for (const [path, hash] of entries) {
    const text = files.get(path);
    if (text !== undefined && sha256(text) === hash) continue;
    // A file that differs from main is reported above.
    if (base?.files.has(path) && base.files.get(path) !== text) continue;
    if (!isNew(path) || baseEntries.has(path))
      fail(
        `released migration ${path} ${text === undefined ? "was renamed or removed" : "changed"}; restore it and add a new migration instead`,
      );
    else
      fail(
        `${MANIFEST}: the entry for ${path}, new on this branch, is stale; refresh it: ${UPDATE}`,
      );
  }
  for (const path of files.keys())
    if (locked(path) && !entries.has(path))
      fail(`${path} is not in ${MANIFEST}; lock it: ${UPDATE}`);

  // 1. Numbering.
  for (const track of TRACKS) {
    const fresh = [...files.keys()].filter(
      (p) => trackOf(p) === track && p.endsWith(".sql") && isNew(p),
    );
    for (const path of fresh)
      if (!track.name.test(path.split("/").pop()!))
        fail(`${path} is not named ${track.form}; rename it`);
    if (!base) continue;
    const highest = Math.max(
      -1,
      ...[...base.files.keys()]
        .filter((p) => trackOf(p) === track)
        .map(numberOf)
        .filter((n) => !Number.isNaN(n)),
    );
    for (const path of fresh) {
      const n = numberOf(path);
      if (n <= highest)
        fail(
          `${path} is numbered ${n}, not above main's highest in ${track.dir} (${highest}); renumber it ${highest + 1} or later`,
        );
      const twin = fresh.find((p) => p !== path && numberOf(p) === n);
      if (twin && path < twin)
        fail(
          `${path} and ${twin} share number ${n}; give each new migration its own number`,
        );
    }
  }
  const journal = JSON.parse(files.get(JOURNAL) ?? '{"entries":[]}') as {
    entries: { idx: number; when: number; tag: string }[];
  };
  journal.entries.forEach((entry, i) => {
    const prior = journal.entries[i - 1];
    if (
      entry.idx !== i ||
      !entry.tag.startsWith(String(i).padStart(4, "0") + "_")
    )
      fail(
        `${JOURNAL}: entry ${i} has idx ${entry.idx} and tag ${entry.tag}; idx and tag run 0, 1, 2… without gaps (regenerate with db:generate)`,
      );
    if (prior && !(entry.when > prior.when))
      fail(
        `${JOURNAL}: ${entry.tag}'s when (${entry.when}) is not after ${prior.tag}'s (${prior.when}); migration timestamps must strictly increase`,
      );
    for (const path of [
      `server/drizzle/${entry.tag}.sql`,
      `server/drizzle/meta/${entry.tag.slice(0, 4)}_snapshot.json`,
    ])
      if (!files.has(path)) fail(`${JOURNAL}: ${entry.tag} has no ${path}`);
  });
  for (const path of files.keys())
    if (
      trackOf(path)?.dir === "server/drizzle" &&
      path.endsWith(".sql") &&
      !journal.entries.some((e) => path === `server/drizzle/${e.tag}.sql`)
    )
      fail(
        `${path} has no entry in ${JOURNAL}, so the migrator never applies it; create migrations with db:generate`,
      );
  if (base?.files.has(JOURNAL)) {
    const main = (JSON.parse(base.files.get(JOURNAL)!) as typeof journal)
      .entries;
    main.forEach((entry, i) => {
      if (JSON.stringify(journal.entries[i]) !== JSON.stringify(entry))
        fail(
          `${JOURNAL}: main's entry ${entry.idx} (${entry.tag}) changed or is missing; journal entries on main never change`,
        );
    });
  }
  const native = [...files.keys()]
    .filter(
      (p) => p.startsWith("apps/auth/migrations/") && p.endsWith(".up.sql"),
    )
    .map((p) => p.slice("apps/auth/migrations/".length, -".up.sql".length))
    .sort();
  if (JSON.stringify(native) !== JSON.stringify(authMigrations))
    fail(
      `apps/auth/scripts/migrations.ts: AUTH_MIGRATIONS must list every apps/auth/migrations/*.up.sql in order (${native.join(", ")}); the migrator applies only listed files`,
    );

  // 3. Drop order.
  const merged = (pr: string) =>
    base?.subjects.some(
      (s) =>
        s.trimEnd().endsWith(`(${pr})`) ||
        s.startsWith(`Merge pull request ${pr} `),
    );
  for (const [path, text] of files) {
    if (!trackOf(path) || !path.endsWith(".sql") || !isNew(path)) continue;
    const { statements, comments } = sqlCode(text);
    const first = (patterns: RegExp[]) =>
      statements
        .flatMap((s) => patterns.map((re) => re.exec(s.code)?.[0]))
        .find(Boolean);
    const found = first(DESTRUCTIVE);
    const inBody = bodyFinding(statements);
    const dynamic = first(DYNAMIC);
    if (!found && !inBody && !dynamic) continue;
    const prs = STOPPED_BY.exec(comments)?.[1]?.split(/\s*,\s*/);
    if (!prs && found)
      fail(
        `${path} drops, truncates or renames something code may use ("${found.slice(0, 60)}"); add a line "-- code-stopped-by: #NN" naming the merged PR that stopped all code using it, and release that code first`,
      );
    else if (!prs && inBody && !NO_DROP.test(comments))
      fail(
        `${path} has a function or DO body that drops, truncates or renames something code may use ("${inBody.slice(0, 60)}"); add "-- code-stopped-by: #NN" if this migration or later code runs it, or "-- no-drop-or-rename: <reason>" if not`,
      );
    else if (!prs && !NO_DROP.test(comments))
      fail(
        `${path} runs dynamic SQL ("${dynamic}"), which this check cannot read; add "-- code-stopped-by: #NN" if it drops, truncates or renames something code may use, or "-- no-drop-or-rename: <reason>" if it does not`,
      );
    else if (prs && base)
      for (const pr of prs.filter((pr) => !merged(pr)))
        fail(
          `${path} names ${pr} in code-stopped-by, but no commit on main merges ${pr}; merge and release that PR before this migration`,
        );
  }
  return failures;
}

// The repository: working-tree files, and main's through git.
const root = fileURLToPath(new URL("..", import.meta.url));
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return r.status === 0 ? r.stdout : undefined;
};
function workingFiles(): Files {
  const files: Files = new Map();
  for (const { dir } of TRACKS)
    for (const name of readdirSync(join(root, dir), {
      recursive: true,
      withFileTypes: true,
    }))
      if (name.isFile()) {
        const path = join(name.parentPath, name.name).slice(root.length);
        files.set(path, readFileSync(join(root, path), "utf8"));
      }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}
function mainInputs(): Inputs["base"] {
  if (!git("rev-parse", "--verify", "-q", "origin/main")) return undefined;
  const base = git("merge-base", "HEAD", "origin/main")?.trim();
  if (!base) return undefined;
  const dirs = TRACKS.map((t) => t.dir);
  const paths = git("ls-tree", "-r", "--name-only", base, "--", ...dirs)!;
  const files: Files = new Map();
  for (const path of paths.split("\n").filter(Boolean))
    files.set(path, git("show", `${base}:${path}`)!);
  return {
    files,
    manifest: git("show", `${base}:${MANIFEST}`),
    subjects: git("log", "--format=%s", base)!.split("\n"),
  };
}

if (import.meta.main) {
  const base = mainInputs();
  const manifest = () => {
    try {
      return readFileSync(join(root, MANIFEST), "utf8");
    } catch {
      return "";
    }
  };
  const inputs: Inputs = {
    files: workingFiles(),
    manifest: manifest(),
    authMigrations: AUTH_MIGRATIONS,
    base,
  };
  const failures: string[] = [];
  if (process.argv.includes("--update"))
    try {
      writeFileSync(join(root, MANIFEST), updatedManifest(inputs));
      console.log(`Updated ${MANIFEST}; commit it with the new migration.`);
    } catch (error) {
      failures.push((error as Error).message);
    }
  failures.push(...checkMigrations({ ...inputs, manifest: manifest() }));
  if (!base) {
    const note =
      "origin/main not found: checked the lock and the journal only, not numbering against main or code-stopped-by PRs. Run `git fetch origin main` for the full check.";
    if (process.env.CI) failures.push(note);
    else console.log(`NOTE: ${note}`);
  }
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length) process.exitCode = 1;
  else
    console.log(
      `PASS migrations: ${[...inputs.files.keys()].filter(locked).length} files locked${base ? ", numbering and drop order checked against main" : ""}.`,
    );
}
