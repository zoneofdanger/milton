#!/usr/bin/env bun
// Vendored by `agent-docs install` from agent-docs commit 7abbead. Do not edit here; update it by running install again.
// agent-docs: checks a repository's concept files (docs/<concept>.md) and the index in AGENTS.md.
// One Markdown file per concept, each with frontmatter name, description, type and covers (the code it
// describes). CI runs `check --base <ref>`: it blocks invalid frontmatter, a stale index, tracked links
// into the scratch folder, and drift (covered code changed without its concept file, unless a commit
// carries a "Docs-unchanged: <concept>: <reason>" trailer). `install` vendors this one file into a
// repository as scripts/agent-docs.ts, so it must import nothing outside Bun's built-in modules.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const TYPES = ["behaviour", "procedure", "reference", "rule", "status", "research"];
export const NO_COVERS = ["rule", "research"]; // the only types that may leave covers out
export const KEYS = ["name", "description", "type", "covers"];
export const MAX_DESCRIPTION = 150;
export const START = "<!-- concepts:start -->";
export const END = "<!-- concepts:end -->";
export const VENDORED = "scripts/agent-docs.ts";
export const TRAILER = "Docs-unchanged";
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const NULL_SHA = /^0{40}$|^0{64}$/; // git's "no commit", e.g. github.event.before on a new branch
const VENDORED_HEADER = /^\/\/ Vendored by `agent-docs install`/m;
// A path into the scratch folder (a bare mention of the folder, or a <placeholder> in it, is fine),
// and a Markdown link whose target is in it.
// A Markdown link target (inline or reference-style) into scratch. Plain paths in prose or
// code are allowed: they name where output goes, not a source to read (Peter, 2026-11-10).
const TMP_LINK = /\]\([^)]*\.agents\/tmp|^\s*\[[^\]]+\]:\s*<?\S*\.agents\/tmp/;

const USAGE = `Usage, from a repository:
  agent-docs check [--base <ref>]   frontmatter, the AGENTS.md index, scratch links and drift; exit 0 ok, 1 problems, 2 error
                                    drift compares the working tree with the merge base of <ref> and HEAD
                                    (default origin/HEAD, else HEAD); a trailer "${TRAILER}: <concept>: <reason>"
                                    on a commit in that range excuses one concept
  agent-docs index                  rewrite the concept index between ${START} and ${END} in AGENTS.md
  agent-docs install                copy this tool to ${VENDORED} and print a GitHub Actions step that runs it`;

export type IO = { cwd: string; out: (s: string) => void; err: (s: string) => void };
export type Concept = {
  rel: string; // docs/deploy/releases.md
  id: string; // deploy/releases
  name: string;
  description: string;
  type: string;
  covers: string[];
  problems: Array<{ line: number; message: string }>;
};

class Fatal extends Error {}

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
}
function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Fatal(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout;
}
const nulList = (s: string) => s.split("\0").filter(Boolean);

// ---------------------------------------------------------------- frontmatter

type Frontmatter = {
  fields: Record<string, string | string[]>;
  lines: Record<string, number>; // 1-based line of each key
  bad: number[]; // lines that are not "key: value" or a "- item" under a key
  duplicate: string[];
  body: string;
};

function scalar(raw: string): string {
  const v = raw.trim();
  const quoted = v.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
  return quoted ? quoted[2] : v.replace(/(^|\s+)#.*$/, "").trim();
}

/** The frontmatter between the first two --- lines: scalars, block lists ("- item") and [a, b] lists. */
export function parseFrontmatter(text: string): Frontmatter | null {
  const src = text.replace(/\r\n/g, "\n");
  const m = src.match(/^---\n([\s\S]*?\n)?---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!m) return null;
  const fm: Frontmatter = { fields: {}, lines: {}, bad: [], duplicate: [], body: m[2] };
  let list: string | null = null;
  (m[1] ?? "").split("\n").forEach((line, i) => {
    const no = i + 2;
    if (!line.trim() || /^\s*#/.test(line)) return;
    const item = line.match(/^\s*-(?:\s+(.*))?$/);
    if (item && list) {
      const value = scalar(item[1] ?? "");
      if (value) (fm.fields[list] as string[]).push(value);
      return;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/);
    if (!kv) return void fm.bad.push(no);
    const [key, raw = ""] = [kv[1], kv[2]];
    if (key in fm.fields) fm.duplicate.push(key);
    fm.lines[key] = no;
    const value = scalar(raw);
    list = null;
    if (!value) (fm.fields[key] = []), (list = key);
    else if (/^\[.*\]$/.test(value)) fm.fields[key] = value.slice(1, -1).split(",").map(scalar).filter(Boolean);
    else fm.fields[key] = value;
  });
  return fm;
}

/** Every problem with one concept file's frontmatter and body, each with the line to look at. */
export function conceptProblems(rel: string, content: string): Concept {
  const id = rel.replace(/^docs\//, "").replace(/\.md$/, "");
  const stem = basename(rel, ".md");
  const c: Concept = { rel, id, name: "", description: "", type: "", covers: [], problems: [] };
  const add = (line: number, message: string) => c.problems.push({ line, message });
  if (!NAME.test(stem)) add(1, "file name must be lowercase letters, digits, - or _, ending in .md");
  const fm = parseFrontmatter(content);
  if (!fm) return add(1, "has no frontmatter; start the file with --- name, description, type, covers ---"), c;
  const at = (key: string) => fm.lines[key] ?? 1;
  const str = (key: string) => (typeof fm.fields[key] === "string" ? (fm.fields[key] as string) : "");
  for (const no of fm.bad) add(no, 'frontmatter line is not "key: value" or a "- item" list entry');
  for (const key of new Set(fm.duplicate)) add(at(key), `frontmatter has ${key} more than once`);
  for (const key of Object.keys(fm.fields).filter((k) => !KEYS.includes(k))) {
    add(at(key), `frontmatter key ${key} is not allowed; use only ${KEYS.join(", ")}`);
  }
  for (const key of ["name", "description", "type"]) {
    if (Array.isArray(fm.fields[key]) && (fm.fields[key] as string[]).length) add(at(key), `${key} must be a single value`);
  }
  c.name = str("name");
  c.description = str("description").replace(/\s+/g, " ");
  c.type = str("type");
  if (!c.name) add(at("name"), `frontmatter is missing name; add "name: ${stem}"`);
  else if (c.name !== stem) add(at("name"), `name ${c.name} does not match the file name; use "name: ${stem}"`);
  if (!c.description) add(at("description"), "frontmatter is missing description; add one line saying what the file covers");
  else if (/^[>|][-+]?$/.test(c.description)) add(at("description"), "description must be on one line");
  else if ([...c.description].length > MAX_DESCRIPTION) {
    add(at("description"), `description is ${[...c.description].length} characters; shorten it to ${MAX_DESCRIPTION}`);
  }
  if (!c.type) add(at("type"), `frontmatter is missing type; use one of ${TYPES.join(", ")}`);
  else if (!TYPES.includes(c.type)) add(at("type"), `type ${c.type} is not one of ${TYPES.join(", ")}`);
  const covers = fm.fields.covers;
  if (typeof covers === "string") add(at("covers"), "covers must be a list (- path/or/glob lines)");
  else if (covers) c.covers = covers.map((g) => g.replace(/^\.\//, ""));
  if (c.type && !NO_COVERS.includes(c.type) && !c.covers.length) {
    add(at("covers"), `type ${c.type} needs covers: list the code this file describes (only ${NO_COVERS.join(" and ")} may omit it)`);
  }
  for (const g of c.covers.filter((g) => g.startsWith("/") || g.split("/").includes(".."))) {
    add(at("covers"), `covers entry ${g} must be relative to the repository root`);
  }
  if (!fm.body.trim()) add(1, "has an empty body");
  return c;
}

// ---------------------------------------------------------------- the repository

/** Tracked and untracked-but-not-ignored files that exist in the working tree. */
function repoFiles(root: string): string[] {
  const files = nulList(gitOk(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  return [...new Set(files)].filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile()).sort();
}

export function readConcepts(root: string, files: string[]): Concept[] {
  return files
    .filter((f) => f.startsWith("docs/") && f.endsWith(".md"))
    .map((rel) => conceptProblems(rel, readFileSync(join(root, rel), "utf-8")))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const indexLines = (concepts: Concept[]) => concepts.map((c) => `- [${c.id}](${c.rel}) — ${c.description}`);

type IndexBlock = { lines: string[]; start: number; end: number } | { error: string; line: number };

function findIndex(text: string): IndexBlock {
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (l.trim() === START ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === END ? [i] : []));
  if (!starts.length && !ends.length) return { error: `has no concept index; run agent-docs index`, line: 1 };
  if (starts.length !== 1 || ends.length !== 1) {
    return { error: `must have exactly one ${START} and one ${END} line`, line: (starts[1] ?? ends[1] ?? starts[0] ?? ends[0]) + 1 };
  }
  if (ends[0] < starts[0]) return { error: `${END} comes before ${START}`, line: ends[0] + 1 };
  return { lines, start: starts[0], end: ends[0] };
}

/** The changed paths since the merge base (old and new path of a rename), and its excusing trailers. */
function changes(root: string, base: string): { paths: Set<string>; excused: Map<string, string>; problems: string[] } {
  const commit = git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).stdout.trim();
  if (!commit) throw new Fatal(`--base ${base} is not a commit here; in CI check out full history (fetch-depth: 0)`);
  const mb = git(root, ["merge-base", commit, "HEAD"]).stdout.trim();
  if (!mb) throw new Fatal(`${base} and HEAD share no history; in CI check out full history (fetch-depth: 0)`);
  const paths = new Set<string>();
  const diff = nulList(gitOk(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", mb]));
  for (let i = 0; i < diff.length; i++) {
    const status = diff[i];
    paths.add(diff[++i]);
    if (/^[RC]/.test(status)) paths.add(diff[++i]);
  }
  for (const f of nulList(gitOk(root, ["ls-files", "-z", "--others", "--exclude-standard"]))) paths.add(f);
  const excused = new Map<string, string>();
  const problems: string[] = [];
  const log = gitOk(root, ["log", "-z", `--format=%h%n%(trailers:key=${TRAILER},valueonly,unfold)`, `${mb}..HEAD`]);
  for (const record of nulList(log)) {
    const [sha, ...values] = record.split("\n");
    for (const v of values.map((s) => s.trim()).filter(Boolean)) {
      const m = v.match(/^([a-z0-9][a-z0-9/_-]*):\s*(\S.*)$/);
      if (m) excused.set(m[1], m[2]);
      else problems.push(`commit ${sha}: ${TRAILER} trailer "${v}" must be "<concept>: <reason>"`);
    }
  }
  return { paths, excused, problems };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function check(root: string, base: string | undefined, io: IO): number {
  const files = repoFiles(root);
  const concepts = readConcepts(root, files);
  const problems: string[] = [];
  const notes: string[] = [];
  const say = (rel: string, line: number, message: string) => problems.push(`${rel}:${line}: ${message}`);

  // Frontmatter, and one concept per name so a trailer names exactly one file.
  const byName = new Map<string, Concept[]>();
  for (const c of concepts) {
    for (const p of c.problems) say(c.rel, p.line, p.message);
    if (c.name) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  }
  for (const [name, same] of byName) {
    if (same.length > 1) for (const c of same) say(c.rel, 1, `name ${name} is also used by ${same.filter((o) => o !== c).map((o) => o.rel).join(", ")}; rename one`);
  }
  for (const c of concepts) {
    for (const g of c.covers) {
      const glob = new Bun.Glob(g);
      if (!files.some((f) => glob.match(f))) say(c.rel, 1, `covers entry ${g} matches no file; fix or remove it`);
    }
  }

  // The index.
  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) {
    if (concepts.length) say("AGENTS.md", 1, "is missing; create it with the hand-written lines, then run agent-docs index");
  } else {
    const block = findIndex(readFileSync(agents, "utf-8"));
    if ("error" in block) {
      if (concepts.length || block.line !== 1) say("AGENTS.md", block.line, block.error);
    } else {
      const have = block.lines.slice(block.start + 1, block.end).filter((l) => l.trim());
      if (have.join("\n") !== indexLines(concepts).join("\n")) say("AGENTS.md", block.start + 1, "concept index does not match docs/; run agent-docs index");
    }
  }

  // Tracked Markdown files that link into the scratch folder.
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const path = join(root, f);
    if (statSync(path).size > 2 * 1024 * 1024) {
      notes.push(`${f}: over 2 MiB, not scanned for scratch links`);
      continue;
    }
    const buf = readFileSync(path);
    if (buf.includes(0)) continue; // binary
    buf.toString("utf-8").split("\n").forEach((line, i) => {
      if (TMP_LINK.test(line)) say(f, i + 1, "links into .agents/tmp, which is scratch; move what it needs into a concept file and link that");
    });
  }

  // Drift.
  const ref = base ?? (git(root, ["rev-parse", "--verify", "--quiet", "origin/HEAD"]).status === 0 ? "origin/HEAD" : "HEAD");
  if (NULL_SHA.test(ref)) notes.push(`drift: skipped, --base ${ref} is git's null commit (a new branch has no base)`);
  else {
    const { paths, excused, problems: trailerProblems } = changes(root, ref);
    problems.push(...trailerProblems);
    for (const c of concepts) {
      if (!c.covers.length || paths.has(c.rel)) continue;
      const globs = c.covers.map((g) => new Bun.Glob(g));
      const hits = [...paths].filter((p) => p !== c.rel && globs.some((g) => g.match(p))).sort();
      if (!hits.length || excused.has(c.name) || excused.has(c.id)) continue;
      const shown = hits.slice(0, 3).join(", ") + (hits.length > 3 ? ` and ${hits.length - 3} more` : "");
      say(c.rel, 1, `drift: ${shown} changed since ${ref} but this file did not; update it, or if it still holds add the commit trailer "${TRAILER}: ${c.name}: <reason>"`);
    }
  }

  if (!concepts.length) notes.push("no docs/ concept files yet: add docs/<concept>.md with frontmatter, then run agent-docs index");
  for (const p of problems) io.out(p);
  for (const n of notes) io.out(`note: ${n}`);
  io.out(problems.length ? `${plural(problems.length, "problem")}.` : `ok: ${plural(concepts.length, "concept file")}.`);
  return problems.length ? 1 : 0;
}

const padded = (entries: string[]) => (entries.length ? ["", ...entries, ""] : []);

export function index(root: string, io: IO): number {
  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) throw new Fatal("no AGENTS.md here; write its hand-written lines first");
  const text = readFileSync(agents, "utf-8");
  const entries = indexLines(readConcepts(root, repoFiles(root)));
  const block = findIndex(text);
  let next: string;
  // Blank lines inside the markers match what prettier writes, so the two never fight.
  if (!("error" in block)) next = [...block.lines.slice(0, block.start + 1), ...padded(entries), ...block.lines.slice(block.end)].join("\n");
  else if (block.line === 1) next = `${text.replace(/\n*$/, "\n")}\n${[START, ...padded(entries), END].join("\n")}\n`;
  else throw new Fatal(`AGENTS.md:${block.line}: ${block.error}`);
  if (next === text) return io.out(`AGENTS.md index is current (${plural(entries.length, "concept")}).`), 0;
  writeFileSync(agents, next);
  io.out(`AGENTS.md index rewritten (${plural(entries.length, "concept")}).`);
  return 0;
}

export const CI_STEP = `# In a job whose checkout has full history:
#   - uses: actions/checkout@v5
#     with:
#       fetch-depth: 0
#   - uses: oven-sh/setup-bun@v2
- name: Concept docs (agent-docs)
  env:
    BASE: \${{ github.event.pull_request.base.sha || github.event.before }}
  run: bun scripts/agent-docs.ts check --base "$BASE"`;

/** Vendors this file into the repository as one self-contained script whose header names its commit. */
export function install(root: string, io: IO, source = import.meta.path): number {
  const text = readFileSync(source, "utf-8");
  if (VENDORED_HEADER.test(text)) throw new Fatal("this is a vendored copy; run install from the agent-docs source tool");
  const dir = dirname(source);
  const sha = git(dir, ["log", "-1", "--format=%h", "--", basename(source)]).stdout.trim() || "uncommitted";
  const dirty = git(dir, ["status", "--porcelain", "--", basename(source)]).stdout.trim() ? "+local-changes" : "";
  const body = text.replace(/^#!.*\n/, "");
  const header = `#!/usr/bin/env bun\n// Vendored by \`agent-docs install\` from agent-docs commit ${sha}${dirty}. Do not edit here; update it by running install again.\n`;
  const target = join(root, VENDORED);
  mkdirSync(dirname(target), { recursive: true });
  const next = header + body;
  const same = existsSync(target) && readFileSync(target, "utf-8") === next;
  if (!same) writeFileSync(target, next, { mode: 0o755 });
  io.out(`${same ? "Unchanged" : "Wrote"} ${VENDORED} (agent-docs ${sha}${dirty}).`);
  io.out(`\nAdd this step to the repository's GitHub Actions workflow (not written):\n\n${CI_STEP}`);
  return 0;
}

// ---------------------------------------------------------------- main

export function main(argv: string[], io: IO): number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || argv.includes("-h") || argv.includes("--help")) return (command ? io.out : io.err)(USAGE), command ? 0 : 2;
  let base: string | undefined;
  if (command === "check" && rest[0] === "--base") {
    if (!rest[1]) return io.err(`--base needs a ref.\n${USAGE}`), 2;
    base = rest[1];
    rest.splice(0, 2);
  }
  if (!["check", "index", "install"].includes(command)) return io.err(`Unknown command: ${command}\n${USAGE}`), 2;
  if (rest.length) return io.err(`${command} does not take ${rest[0]}.\n${USAGE}`), 2;
  try {
    const top = git(io.cwd, ["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) throw new Fatal("not in a git repository");
    const root = top.stdout.trim();
    if (command === "check") return check(root, base, io);
    if (command === "index") return index(root, io);
    return install(root, io);
  } catch (err: any) {
    return io.err(`agent-docs ${command}: ${err instanceof Fatal ? err.message : `failed: ${err?.message ?? err}`}`), 2;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), { cwd: process.cwd(), out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") }));
}
