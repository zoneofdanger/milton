import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";

/** Refuses when a fixture's fixed local port is taken, so a run never joins
 * another process. */
export const assertPortFree = (port: number, refusal: string) =>
  new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once("error", () => reject(new Error(refusal)));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
  });

/** Ends `pool` and waits for each of its connections to close. pg-pool's end()
 * resolves once it has asked its clients to close, not once they have, so a
 * cluster stopped right after it can still find an idle session and end it with
 * 57P01 ("terminating connection due to administrator command"), which the pool
 * raises as an unhandled error. The wait stops after 5 s: a loopback close takes
 * milliseconds, and pg-pool emits no "remove" for a client whose connect fails
 * while the pool ends. */
export async function endPool(pool: pg.Pool) {
  let open = pool.totalCount,
    timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve) => {
    if (!open) return resolve();
    pool.on("remove", () => {
      if (--open === 0) resolve();
    });
    timer = setTimeout(resolve, 5000);
  });
  try {
    await pool.end();
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

/** A one-day self-signed certificate for `name` and its 0600 key, in `dir`. */
export function selfSignedCertificate(
  dir: string,
  name: string,
  altNames: string,
) {
  const cert = join(dir, "cert.pem"),
    key = join(dir, "key.pem");
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=${altNames}`,
    ],
    { stdio: "ignore", env: { PATH: process.env.PATH, LC_ALL: "C" } },
  );
  if (r.status !== 0) throw new Error("fixture_tls_generation_failed");
  chmodSync(key, 0o600);
  return { cert, key };
}

/** A disposable PostgreSQL 18 cluster on 127.0.0.1:`port` with TLS and quiet
 * logs. The `disposable_cluster` superuser is trusted over the socket in `dir`
 * and over local TCP; `hba` adds the lines for every other login. */
export async function startCluster(options: {
  port: number;
  prefix: string;
  portRefusal: string;
  hba: string;
}) {
  const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@18/bin";
  await assertPortFree(options.port, options.portRefusal);
  const dir = mkdtempSync(join(tmpdir(), options.prefix));
  const data = join(dir, "pgdata");
  const command = (name: string, args: string[]) => {
    const r = spawnSync(join(bin, name), args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, LC_ALL: "C", HOME: dir },
    });
    if (r.status !== 0) throw new Error(`disposable_${name}_exit_${r.status}`);
  };
  let running = false;
  const stop = () => {
    try {
      if (running) command("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      running = false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    command("initdb", [
      "-D",
      data,
      "--username=disposable_cluster",
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    const { cert, key } = selfSignedCertificate(
      dir,
      "localhost",
      "DNS:localhost,IP:127.0.0.1",
    );
    writeFileSync(
      join(data, "postgresql.auto.conf"),
      `listen_addresses='127.0.0.1'\nport=${options.port}\nunix_socket_directories='${dir}'\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\nlog_statement='none'\nlog_min_messages='panic'\nlog_min_error_statement='panic'\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(data, "pg_hba.conf"),
      "local all all trust\nhost all disposable_cluster 127.0.0.1/32 trust\n" +
        options.hba,
      { mode: 0o600 },
    );
    command("pg_ctl", ["-D", data, "-l", join(dir, "pg.log"), "-w", "start"]);
    running = true;
    return { dir, cert, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
