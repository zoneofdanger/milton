import type pg from "pg";

// Keep this small policy local: auth cannot import the writing runtime. URL TLS
// options must not replace pg's verified defaults or select libpq's weaker modes.
export function databaseOptions(value: string): pg.PoolConfig {
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    if (
      /[\r\n\0]/.test(value) ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      new Set(keys).size !== keys.length ||
      keys.some(
        (k) =>
          /^(ssl|uselibpqcompat)/i.test(k) &&
          !["sslmode", "sslrootcert"].includes(k),
      ) ||
      !["require", "verify-full"].includes(
        url.searchParams.get("sslmode") ?? "verify-full",
      )
    )
      throw new Error();
    // 'require' is accepted only as an upgrade to full certificate/host validation.
    url.searchParams.delete("sslmode");
    return { connectionString: url.href, ssl: { rejectUnauthorized: true } };
  } catch {
    throw new Error("verified_auth_database_tls_required");
  }
}
