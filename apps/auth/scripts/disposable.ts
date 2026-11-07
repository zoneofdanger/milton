import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { startCluster } from "./cluster.ts";

export async function disposable(
  prerequisitesFile = new URL(
    "../migrations/000-owner-prerequisites.sql",
    import.meta.url,
  ),
) {
  const port = 55543;
  const cluster = await startCluster({
    port,
    prefix: "milton-auth-disposable-",
    portRefusal: "disposable_port_in_use",
    hba: "host all all 127.0.0.1/32 scram-sha-256\n",
  });
  const cert = cluster.cert;
  try {
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
        cluster.stop();
      },
    };
  } catch (e) {
    cluster.stop();
    throw e;
  }
}
