#!/bin/sh
# make-repo.sh 1|2 rebuilds /private/tmp/sam-demo as Sam's small "invoicer" repo
# for the standup scenes (docs/demo.md).
#   1: yesterday's commits fixed the CSV export's timezone bug and added a DST test.
#   2: those commits move a day back; yesterday's commits added webhook retries with
#      backoff and retry logging, and TODO.md marks pagination blocked.
# Dates count calendar days back from the day it runs, so Day 2 works recorded the
# next morning (preferred: Claude's dates are then real) or right after Day 1.
# The code is real and its test passes: on camera Claude flags stub code.
# POSIX sh; uses macOS `date -v`.
set -eu

REPO=/private/tmp/sam-demo

case "${1-}" in
1 | 2) DAY=$1 ;;
*)
  echo "usage: sh scripts/demo/make-repo.sh 1|2" >&2
  exit 2
  ;;
esac

# Refuse before deleting anything unless the folder really is /private/tmp/sam-demo
# (not a link to somewhere else).
mkdir -p "$REPO"
cd "$REPO"
if [ "$(pwd -P)" != "$REPO" ]; then
  echo "make-repo: $REPO resolves to $(pwd -P); refusing" >&2
  exit 1
fi
find "$REPO" -mindepth 1 -delete

# Nothing from the person's git config: no hooks, signing or identity. Sam's
# identity goes in the repo's local config, which Claude Code reads (it does not
# use the driver's GIT_CONFIG_GLOBAL for the git user).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q -b main
git config user.name Sam
git config user.email sam@example.com

# when DAYS_AGO HH:MM:SS prints that local time, DAYS_AGO calendar days back.
when() { date -v-"$1"d "+%Y-%m-%dT$2"; }
# commit DATE MESSAGE PATH...: stages exactly those paths and commits them.
commit() {
  at=$1 message=$2
  shift 2
  git add -- "$@"
  GIT_AUTHOR_DATE=$at GIT_COMMITTER_DATE=$at git commit -q -m "$message"
}

# Day 1's "yesterday" is Day 2's "two days ago".
CSV_DAY=$DAY

mkdir src
cat >README.md <<'EOF'
# invoicer

Small invoicing service.
EOF
cat >TODO.md <<'EOF'
- [ ] Fix timezone offset in CSV export
- [ ] Retry failed webhook deliveries
- [ ] Paginate GET /invoices
EOF
cat >src/export.js <<'EOF'
export function toCsv(rows) {
  return rows.map((r) => r.join(",")).join("\n");
}
EOF
cat >src/webhooks.js <<'EOF'
export async function deliver(hook, body) {
  return fetch(hook.url, { method: "POST", body });
}
EOF
commit "$(when $((CSV_DAY + 5)) 10:00:00)" "Initial invoicer service" \
  README.md TODO.md src/export.js src/webhooks.js

# sv-SE formats a date as "2026-03-08 03:30:00": no comma to break the CSV row.
cat >src/export.js <<'EOF'
export function toCsv(rows, tz = "UTC") {
  const cell = (v) =>
    v instanceof Date ? v.toLocaleString("sv-SE", { timeZone: tz }) : v;
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}
EOF
cat >TODO.md <<'EOF'
- [x] Fix timezone offset in CSV export
- [ ] Retry failed webhook deliveries
- [ ] Paginate GET /invoices
EOF
commit "$(when "$CSV_DAY" 11:20:00)" "Fix timezone offset in CSV export" \
  src/export.js TODO.md

cat >src/export.test.js <<'EOF'
import { expect, test } from "bun:test";
import { toCsv } from "./export.js";

test("CSV export uses the local time across the DST change", () => {
  // New York springs forward at 07:00 UTC on 2026-03-08.
  const before = new Date("2026-03-08T06:30:00Z");
  const after = new Date("2026-03-08T07:30:00Z");
  expect(toCsv([[before], [after]], "America/New_York")).toBe(
    "2026-03-08 01:30:00\n2026-03-08 03:30:00",
  );
});
EOF
commit "$(when "$CSV_DAY" 15:05:00)" "Add DST boundary test for CSV export" \
  src/export.test.js

if [ "$DAY" = 2 ]; then
  cat >src/webhooks.js <<'EOF'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deliver(hook, body, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(hook.url, { method: "POST", body });
    if (res.ok || attempt === tries) return res;
    await sleep(2 ** attempt * 500);
  }
}
EOF
  cat >TODO.md <<'EOF'
- [x] Fix timezone offset in CSV export
- [x] Retry failed webhook deliveries
- [ ] Paginate GET /invoices (blocked: waiting on staging db access)
EOF
  commit "$(when 1 10:40:00)" "Retry failed webhook deliveries with backoff" \
    src/webhooks.js TODO.md

  cat >src/webhooks.js <<'EOF'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deliver(hook, body, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(hook.url, { method: "POST", body });
    if (res.ok || attempt === tries) return res;
    console.warn(
      `webhook ${hook.id}: attempt ${attempt} got ${res.status}, retrying`,
    );
    await sleep(2 ** attempt * 500);
  }
}
EOF
  commit "$(when 1 16:10:00)" "Log each webhook retry attempt" src/webhooks.js
fi

git log --format='%ad %an %s' --date=format:'%a %Y-%m-%d %H:%M'
