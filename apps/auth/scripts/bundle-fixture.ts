import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import type pg from "pg";
import type { Config } from "../src/config.ts";
export async function bundleFixture(
  config: Config,
  database: pg.PoolConfig,
  caPath: string,
) {
  const port = 19912;
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once("error", () => reject(new Error("bundle_port_in_use")));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
  });
  const dsn = new URL(
    "postgresql://127.0.0.1:" + database.port + "/" + database.database,
  );
  dsn.username = database.user!;
  dsn.password = String(database.password);
  // Production refuses a loopback admission origin. Nothing here admits, so this
  // run.app origin is never fetched.
  const admission = "https://milton-admit-419545871671.us-east4.run.app";
  const workerEnv = {
    PATH: process.env.PATH,
    LC_ALL: "C",
    NODE_ENV: "production",
    NODE_EXTRA_CA_CERTS: caPath,
    ...Object.fromEntries(
      Object.entries(config).map(([k, v]) => [k, String(v)]),
    ),
    AUTH_DATABASE_URL: dsn.href,
    AUTH_ADMISSION_URL: admission,
  };
  for (const args of [[], ["--apply"]]) {
    const delivery = spawnSync(
      process.execPath,
      args.length
        ? [
            "--input-type=module",
            "-e",
            `globalThis.fetch=async()=>{throw new Error("fixture_external_network_refused")}; process.argv=[process.execPath,${JSON.stringify(new URL("../dist/deliver.js", import.meta.url).pathname)},"--apply"]; await import(${JSON.stringify(new URL("../dist/deliver.js", import.meta.url).href)});`,
          ]
        : [new URL("../dist/deliver.js", import.meta.url).pathname],
      {
        env: args.length ? workerEnv : { PATH: process.env.PATH, LC_ALL: "C" },
        encoding: "utf8",
        timeout: 12000,
      },
    );
    assert.equal(delivery.status, 0, "compiled delivery closure must run");
    // One JSON line, which Cloud Logging stores as jsonPayload for the
    // milton-auth-mail-failed and -throttled log metrics.
    assert(
      args.length
        ? delivery.stdout.includes(
            '{"message":"auth_mail_pass","claimed":0,"sent":0,"retry":0,"failed":0,"throttled":0}\n',
          )
        : delivery.stdout.includes("Dry run:"),
    );
  }
  const child = spawn(
    process.execPath,
    [new URL("../dist/cloud-run.js", import.meta.url).pathname],
    {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        NODE_EXTRA_CA_CERTS: caPath,
        ...Object.fromEntries(
          Object.entries(config).map(([k, v]) => [k, String(v)]),
        ),
        AUTH_DATABASE_URL: dsn.href,
        AUTH_ADMISSION_URL: admission,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (part) => {
    output += String(part);
  });
  child.stderr.on("data", (part) => {
    output += String(part);
  });
  try {
    const status = () =>
      new Promise<number>((resolve, reject) => {
        const r = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            headers: {
              host: "auth.meetmilton.com",
              "x-forwarded-host": "attacker.invalid",
              "x-forwarded-proto": "http",
            },
          },
          (res) => {
            res.resume();
            res.once("end", () => resolve(res.statusCode ?? 0));
          },
        );
        r.once("error", reject);
        r.setTimeout(1000, () => r.destroy(new Error("bundle_probe_timeout")));
        r.end();
      });
    let ready = false;
    for (let n = 0; n < 40; n++) {
      if (child.exitCode !== null) throw new Error("bundle_startup_failure");
      try {
        if ((await status()) === 200) {
          ready = true;
          break;
        }
      } catch {
        /* The owned listener is starting. */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(ready, "compiled bundle must start and serve canonical health");
    assert(!output.includes("SERVER_ERROR"));
    assert(!output.includes("ZodLazy"));
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("owned_bundle_shutdown_timeout"));
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  }
}
