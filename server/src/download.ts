import { zipSync } from "fflate";
import { StoreError, TPS_REPORT_KEY, type MemoSnapshot } from "./store";

export function memoArchive(memos: readonly MemoSnapshot[]) {
  const files: Record<string, Uint8Array> = Object.create(null);
  const encode = (text: string) => new TextEncoder().encode(text);
  let bytes = 0;
  for (const memo of memos) {
    if (memo.archived) continue;
    const path =
      memo.name === TPS_REPORT_KEY ? "TPS.md" : `${memo.name}/SKILL.md`;
    files[path] = encode(
      memo.name === TPS_REPORT_KEY
        ? memo.text
        : `---\nname: ${JSON.stringify(memo.name)}\ndescription: ${JSON.stringify(memo.description)}\n---\n${memo.text}`,
    );
    bytes += files[path]!.length;
    if (bytes > 4_000_000)
      throw new StoreError(
        "download_too_large",
        "The download exceeds its size limit.",
        422,
      );
  }
  const archive = zipSync(files, { level: 0 });
  if (archive.byteLength > 4_000_000)
    throw new StoreError(
      "download_too_large",
      "The download exceeds its size limit.",
      422,
    );
  return archive;
}

export function downloadResponse(memos: readonly MemoSnapshot[]) {
  return new Response(memoArchive(memos), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="milton-memos.zip"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
