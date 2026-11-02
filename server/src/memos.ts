import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Memo {
  name: string;
  description: string;
  text: string;
}

// Memos use two single-line fields, including plain descriptions with colons.
// Keep the original Markdown intact when serving it.
export function parseMemo(folder: string, text: string): Memo {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) throw new Error(`${folder}: missing frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description):\s*(.+)$/.exec(line);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^[|>]/.test(value)) {
      throw new Error(
        `${folder}: ${field[1]} must be a single line, not a block scalar`,
      );
    }
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "string") throw new Error();
        value = parsed;
      } catch {
        throw new Error(`${folder}: invalid quoted ${field[1]}`);
      }
    } else if (value.startsWith("'")) {
      if (
        value.length < 2 ||
        !value.endsWith("'") ||
        value.slice(1, -1).replaceAll("''", "").includes("'")
      ) {
        throw new Error(`${folder}: invalid quoted ${field[1]}`);
      }
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    if (fields.has(field[1]!))
      throw new Error(`${folder}: duplicate ${field[1]}`);
    fields.set(field[1]!, value);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (name !== folder || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${folder}: frontmatter name must match its folder`);
  }
  if (!description) {
    throw new Error(`${folder}: description must be a single line`);
  }
  return { name, description, text };
}

export async function loadMemos(directory: string | URL): Promise<Memo[]> {
  const root = directory instanceof URL ? fileURLToPath(directory) : directory;
  const entries = await readdir(root, { withFileTypes: true });
  const memos: Memo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    let text: string;
    try {
      text = await readFile(join(root, entry.name, "SKILL.md"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    memos.push(parseMemo(entry.name, text));
  }
  return memos;
}
