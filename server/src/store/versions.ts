import { Buffer } from "node:buffer";

// Encode the complete immutable id: truncation would weaken incarnation fencing.
export function versionTag(name: string, number: number, id: string) {
  return `${name}@${number}·${Buffer.from(id, "utf8").toString("base64url")}`;
}

export function parseVersionTag(tag: string) {
  const match =
    /^([a-z0-9]+(?:-[a-z0-9]+)*)@([1-9][0-9]*)·([A-Za-z0-9_-]+)$/.exec(tag);
  if (!match || tag.length > 512) return null;
  const number = Number(match[2]);
  const id = Buffer.from(match[3]!, "base64url").toString("utf8");
  if (
    !id ||
    !Number.isSafeInteger(number) ||
    number > 2147483647 ||
    versionTag(match[1]!, number, id) !== tag
  )
    return null;
  return { name: match[1]!, number, id };
}
