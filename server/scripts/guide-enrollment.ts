import { parseArgs } from "node:util";
import { postgresDatabase } from "../src/store/database";
import { setGuideEnrollment } from "../src/guides/store";
import { resumeGuides } from "../src/guides/resume";
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
  const resume = action === "resume" && positionals.length === 1;
  if (
    !url ||
    (!resume &&
      (!userId ||
        positionals.length !== 2 ||
        !["enable", "disable"].includes(action!)))
  )
    throw new Error("configuration");
  const db = postgresDatabase(url);
  await verifyDatabaseTarget(db);
  if (resume) {
    // Restores the trigger 0010 dropped and resyncs every report (deploy/guides.md).
    await resumeGuides(db);
    console.info("Guide pilot resumed.");
  } else {
    await setGuideEnrollment(db, userId!, {
      enabled: action === "enable",
      optInReference: values["consent-ref"],
    });
    console.info("Guide enrollment updated.");
  }
} catch {
  console.error(
    "Guide enrollment failed. Use enable USER --consent-ref OPAQUE_REFERENCE, disable USER or resume with the owner URL.",
  );
  process.exitCode = 1;
}
