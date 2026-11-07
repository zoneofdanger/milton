import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import pg from "pg";

export async function disposable(
  prerequisitesFile = new URL(
    "../migrations/000-owner-prerequisites.sql",
    import.meta.url,
  ),
) {
  const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@18/bin";
  const port = 55543;
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once("error", () => reject(new Error("disposable_port_in_use")));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
  });
  const dir = mkdtempSync(join(tmpdir(), "milton-auth-disposable-"));
  const command = (name: string, args: string[]) => {
    const r = spawnSync(join(bin, name), args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, LC_ALL: "C", HOME: dir },
    });
    if (r.status !== 0) throw new Error(`disposable_${name}_exit_${r.status}`);
  };
  let running = false;
  try {
    command("initdb", [
      "-D",
      join(dir, "pgdata"),
      "--username=disposable_cluster",
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    const cert = join(dir, "cert.pem"),
      key = join(dir, "key.pem");
    const tls = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore", env: { PATH: process.env.PATH, LC_ALL: "C" } },
    );
    if (tls.status !== 0) throw new Error("fixture_tls_generation_failed");
    const chmod = spawnSync("chmod", ["600", key]);
    if (chmod.status !== 0) throw new Error("fixture_tls_permissions_failed");
    writeFileSync(
      join(dir, "pgdata", "postgresql.auto.conf"),
      `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${dir}'\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\nlog_statement='none'\nlog_min_messages='panic'\nlog_min_error_statement='panic'\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(dir, "pgdata", "pg_hba.conf"),
      "local all all trust\nhost all disposable_cluster 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n",
      { mode: 0o600 },
    );
    command("pg_ctl", [
      "-D",
      join(dir, "pgdata"),
      "-l",
      join(dir, "pg.log"),
      "-w",
      "start",
    ]);
    running = true;
    const admin = new pg.Pool({
      host: "127.0.0.1",
      port,
      user: "disposable_cluster",
      database: "postgres",
    });
    const configs: Record<string, pg.PoolConfig> = {};
    await admin.query(
      "CREATE ROLE fictional_retained LOGIN NOINHERIT; CREATE ROLE fictional_temp LOGIN NOINHERIT",
    );
    await admin.query("CREATE DATABASE milton_auth_disposable");
    const setup = new pg.Pool({
      host: "127.0.0.1",
      port,
      user: "disposable_cluster",
      database: "milton_auth_disposable",
      max: 1,
    });
    const prerequisites = readFileSync(prerequisitesFile, "utf8");
    try {
      await setup.query(
        "GRANT TEMP ON DATABASE milton_auth_disposable TO fictional_temp",
      );
      for (const inventory of [
        null,
        [],
        [
          { role: "fictional_retained", temp: false },
          { role: "fictional_retained", temp: false },
        ],
        [
          { role: "fictional_retained", temp: false },
          { role: "fictional_temp", temp: false },
        ],
      ]) {
        if (inventory !== null)
          await setup.query(
            "select set_config('milton.retained_logins',$1,false)",
            [JSON.stringify(inventory)],
          );
        await assert.rejects(
          setup.query(prerequisites),
          /inventory|TEMP dependency/,
        );
        await setup.query("ROLLBACK");
        assert.equal(
          (
            await setup.query(
              "select has_database_privilege('fictional_retained',current_database(),'CONNECT') as allowed",
            )
          ).rows[0].allowed,
          true,
        );
        assert.equal(
          (
            await setup.query(
              "select count(*)::int n from pg_roles where rolname='milton_auth_owner'",
            )
          ).rows[0].n,
          0,
        );
      }
      await setup.query(
        "select set_config('milton.retained_logins',$1,false)",
        [
          JSON.stringify([
            { role: "fictional_retained", temp: false },
            { role: "fictional_temp", temp: true },
          ]),
        ],
      );
      await setup.query(prerequisites);
      const retainedPassword = randomBytes(32).toString("hex");
      await setup.query(
        `ALTER ROLE fictional_retained PASSWORD '${retainedPassword}'`,
      );
      const retained = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "fictional_retained",
        password: retainedPassword,
        database: "milton_auth_disposable",
      });
      try {
        assert.equal(
          (await retained.query("select current_user")).rows[0].current_user,
          "fictional_retained",
        );
        await assert.rejects(
          retained.query("create temp table forbidden_temp(id int)"),
          /permission denied/,
        );
      } finally {
        await retained.end();
      }
      assert.equal(
        (
          await setup.query(
            "select has_database_privilege('fictional_temp',current_database(),'TEMP') as allowed",
          )
        ).rows[0].allowed,
        true,
      );
      const ownerPassword = randomBytes(32).toString("hex");
      await setup.query(
        `CREATE ROLE fictional_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${ownerPassword}'; GRANT milton_auth_owner TO fictional_migrator WITH INHERIT FALSE, SET TRUE; GRANT CONNECT ON DATABASE milton_auth_disposable TO fictional_migrator`,
      );
      configs.owner = {
        host: "127.0.0.1",
        port,
        user: "fictional_migrator",
        password: ownerPassword,
        database: "milton_auth_disposable",
        options: "-c role=milton_auth_owner",
        ssl: { ca: readFileSync(cert, "utf8"), rejectUnauthorized: true },
        max: 1,
      };
      for (const service of ["auth", "app", "mcp"]) {
        const password = randomBytes(32).toString("hex");
        await setup.query(
          `ALTER ROLE milton_${service}_runtime LOGIN PASSWORD '${password}'`,
        );
        configs[service] = {
          host: "127.0.0.1",
          port,
          user: `milton_${service}_runtime`,
          password,
          database: "milton_auth_disposable",
          max: 8,
          ssl: { ca: readFileSync(cert, "utf8"), rejectUnauthorized: true },
        };
      }
    } finally {
      await setup.end();
      await admin.end();
    }
    const owner = new pg.Pool(configs.owner);
    const effective = (await owner.query("select current_user, session_user"))
      .rows[0];
    assert.equal(effective.current_user, "milton_auth_owner");
    assert.equal(effective.session_user, "fictional_migrator");
    return {
      owner,
      configs,
      caPath: cert,
      stop: async () => {
        await owner.end();
        command("pg_ctl", [
          "-D",
          join(dir, "pgdata"),
          "-m",
          "fast",
          "-w",
          "stop",
        ]);
        running = false;
        rmSync(dir, { recursive: true });
      },
    };
  } catch (e) {
    if (running)
      command("pg_ctl", [
        "-D",
        join(dir, "pgdata"),
        "-m",
        "fast",
        "-w",
        "stop",
      ]);
    rmSync(dir, { recursive: true });
    throw e;
  }
}
