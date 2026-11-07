import { parseArgs } from "node:util";
import { postgresDatabase } from "../src/store/database";
import { setGuideEnrollment } from "../src/guides/store";
import { verifyDatabaseTarget } from "./database-config";

// Explicit operator-only action. Never falls back to .dev.vars or runtime credentials.
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { "consent-ref": { type: "string" } },
  });
  const [action, userId] = positionals;
  const url = process.env.MILTON_OWNER_DATABASE_URL;
  if (
    !url ||
    !userId ||
    positionals.length !== 2 ||
    !["enable", "disable"].includes(action!)
  )
    throw new Error("configuration");
  const db = postgresDatabase(url);
  await verifyDatabaseTarget(db);
  await setGuideEnrollment(db, userId, {
    enabled: action === "enable",
    optInReference: values["consent-ref"],
  });
  console.info("Guide enrollment updated.");
} catch {
  console.error(
    "Guide enrollment failed. Use enable USER --consent-ref OPAQUE_REFERENCE or disable USER with the owner URL.",
  );
  process.exitCode = 1;
}
