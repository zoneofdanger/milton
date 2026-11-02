import { deliveryStatus } from "./context";
import {
  checkDraft,
  checkDependencies,
  checkPackageManager,
  prepareCorrection,
  type Constraint,
  type Scope,
} from "./checks";

const usage = `Milton local agent kit (Bun; no network calls)
  status                 Read a cover-sheet JSON response on stdin; print revision and report count.
  check                  Read {text,scope,constraints} on stdin; check explicit local rules.
  dependencies           Read {before,after,allowedAdditions?} package manifests on stdin.
  manager                Read {choice,policy:{standingDefault?,projectRequired?}} on stdin.
  prepare-correction     Read {report,before,after,userDirected:true}; prepare create_memo arguments.
Exit: 0 pass/prepared; 1 invalid input/configuration; 2 a configured check failed.`;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const output = (v: unknown) =>
  process.stdout.write(
    typeof v === "string" ? v + "\n" : JSON.stringify(v) + "\n",
  );

async function input() {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of Bun.stdin.stream()) {
    size += part.byteLength;
    if (size > 1048576) throw new Error();
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

async function main() {
  const [command, extra] = process.argv.slice(2);
  if (command === "--help" || !command) {
    output(usage);
    return;
  }
  if (extra !== undefined) throw new Error();
  const raw = await input();
  if (command === "status") {
    output(deliveryStatus(raw));
    return;
  }
  if (!object(raw)) throw new Error();
  let result: ReturnType<typeof checkDraft>;
  switch (command) {
    case "check":
      if (
        typeof raw.text !== "string" ||
        typeof raw.scope !== "string" ||
        !Array.isArray(raw.constraints)
      )
        throw new Error();
      result = checkDraft(
        raw.text,
        raw.scope as Scope,
        raw.constraints as Constraint[],
      );
      break;
    case "dependencies":
      if (
        !object(raw.before) ||
        !object(raw.after) ||
        (raw.allowedAdditions !== undefined &&
          (!Array.isArray(raw.allowedAdditions) ||
            !raw.allowedAdditions.every((x) => typeof x === "string")))
      )
        throw new Error();
      result = checkDependencies(
        raw.before,
        raw.after,
        raw.allowedAdditions as string[] | undefined,
      );
      break;
    case "manager":
      if (
        typeof raw.choice !== "string" ||
        !object(raw.policy) ||
        Object.values(raw.policy).some((v) => typeof v !== "string")
      )
        throw new Error();
      result = checkPackageManager(raw.choice, raw.policy);
      break;
    case "prepare-correction":
      if (
        typeof raw.before !== "string" ||
        typeof raw.after !== "string" ||
        raw.userDirected !== true
      )
        throw new Error();
      output(
        prepareCorrection(raw.report, {
          before: raw.before,
          after: raw.after,
          userDirected: true,
        }),
      );
      return;
    default:
      throw new Error();
  }
  output(result);
  if (result.status === "fail") process.exitCode = 2;
}
try {
  await main();
} catch {
  process.stderr.write(
    "Invalid or unavailable local input/configuration. No network request was made. Use --help.\n",
  );
  process.exitCode = 1;
}
