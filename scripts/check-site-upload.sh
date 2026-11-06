#!/usr/bin/env bash
# Build the static site from exactly the files Vercel uploads, as .vercelignore keeps
# them, so an import from outside that set fails here instead of in production.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git ls-files --cached --ignored --exclude-from=.vercelignore >"$work/excluded"
mkdir "$work/upload"
git ls-files | grep -vxFf "$work/excluded" | tar -cf - -T - | tar -xf - -C "$work/upload"

cd "$work/upload"
bun install --frozen-lockfile
bun run build
