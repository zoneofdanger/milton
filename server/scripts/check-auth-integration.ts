import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
const base = new URL("../dist/", import.meta.url).pathname;
await mkdir(base, { recursive: true });
const dir = await mkdtemp(join(base, "auth-integration-"));
try {
  const result = await Bun.build({
    entrypoints: [new URL("./auth-integration.ts", import.meta.url).pathname],
    outdir: dir,
    target: "node",
    format: "esm",
    naming: "integration.mjs",
    external: ["zod", "pg-native"],
  });
  if (!result.success) throw new Error("local integration bundle failed");
  const child = Bun.spawn(["node", join(dir, "integration.mjs")], {
    cwd: new URL("../", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      NODE_ENV: "test",
      ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  await rm(dir, { recursive: true, force: true });
}
