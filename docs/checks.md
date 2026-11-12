---
name: checks
description: What CI runs on every push and PR, the migration guards, the copy-drift and contrast tests, agent-docs check, and the theme package
type: reference
covers:
  - .github/workflows/**
  - scripts/**
  - packages/theme/*.css
  - packages/theme/{assets,brand,contrast,contrast.test}.ts
  - packages/theme/public/**
  - packages/theme/{package.json,tsconfig.json,README.md}
  - server/test/copy-drift.test.ts
  - server/scripts/check-auth-integration.ts
  - .vercelignore
  - package.json
---

# Checks

What to run before handing work back is in [agents/working](agents/working.md).

## CI

- CI (`.github/workflows/checks.yml`) runs on every push and pull request to main: the
  migration guards, the concept docs check, types, tests, formatting, the site upload
  build, and both integration suites (the server's auth rehearsal and the `apps/auth`
  suite) on PostgreSQL 18 under Node 26. It holds no secrets and does not deploy.
- `bun run build:site-upload` (`scripts/check-site-upload.sh`) builds the site from
  exactly the files `.vercelignore` keeps ([site](site.md)), so an import from outside
  that set fails in CI instead of in production.

## Migration guards

`scripts/check-migrations.ts` runs on every pull request, against the merge base with
`origin/main`. Without origin/main it checks only the lock and journal and says so; in
CI that fails.

- A new migration in `server/drizzle/`, `server/migrations/` or
  `apps/auth/migrations/` is numbered above main's highest in its track, with a number
  of its own; the Drizzle journal's idx and tag run without gaps and its `when` values
  strictly increase.
- `scripts/released-migrations.sha256` locks every migration file and Drizzle snapshot;
  main's entries never change. Lock a new one with
  `bun scripts/check-migrations.ts --update` and commit the manifest with it.
- A new migration that drops, truncates or renames a table, column, view, schema, type
  (attribute or enum value) or function carries a line `-- code-stopped-by: #NN` naming
  the merged PR that stopped all code using it, and ships only after that code is
  released ([database](database.md)). Index, sequence, trigger and constraint drops and
  renames do not need it. Comments and string literals are skipped.
- Dynamic SQL (a `DO` block or `EXECUTE`, also inside a function or procedure body)
  cannot be read, so it needs that line or `-- no-drop-or-rename: <reason>`, as does a
  function, procedure, `DO` or `EXECUTE` body that itself drops, truncates or renames
  one of those; a plain function body, a trigger's `EXECUTE FUNCTION` and
  `GRANT EXECUTE` pass.

## Concept docs

- `agent-docs check` (`scripts/agent-docs.ts`, vendored by `agent-docs install`) fails
  on invalid concept frontmatter, an AGENTS.md index that does not match `docs/`, a
  Markdown link from a tracked Markdown file into `.agents/tmp`, or drift: a change to
  code a concept file covers without a change to that file, unless a
  `Docs-unchanged: <concept>: <reason>` commit trailer excuses it. It prints a note for a
  file over 2 MiB that it cannot check. `agent-docs index` rewrites the index in the form
  prettier keeps, so AGENTS.md is formatted like any other file.
- The no-tmp-links test in `server/test/copy-drift.test.ts` is stricter: it fails when
  any tracked text file, of any size, mentions `.agents/tmp`, except the known mentions
  it lists with their reasons.

## Copy drift

- The retired-words check fails, listing file:line, when the site, the consent screen,
  the app's pages, README, TODO or AGENTS say a word memos replaced (`list_reports`,
  exact edits, instruction cards, writing rules, samples) or "assistant"; identifiers
  and keys pass, and lines between `retired-words: off` and `retired-words: on` markers
  are historical and skipped. `docs/` is not scanned.
- The shared-facts check fails when README lacks the standing line or a site page or app
  page states another trial length or price than `packages/theme/facts.ts`
  ([setup](setup.md)).
- The privacy check fails when the privacy page claims legacy data is never served or
  drops its disclosure that an exact resend of a pre-release save returns that stored
  receipt, marked as a past receipt ([saves](saves.md#receipts)).

## Theme

- `packages/theme` supplies fonts, favicons and tokens (`base.css`), with a WCAG contrast
  test (`contrast.test.ts`) over text pairs, functional borders and the matching dark
  declarations. Pages and screens are built from it.
- App and auth text outside the Latin JetBrains Mono subset fetches the full master on
  demand, which also renders a non-Latin letter with its combining mark; the site serves
  only the subset.
- `assets.ts` gives the app and auth services content-versioned static assets: the
  build writes a manifest of content hashes and points CSS `url()`s at versioned URLs,
  and the server loads, verifies and compresses each file once at startup
  ([hosting](hosting.md)).
