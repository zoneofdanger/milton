# Milton landing page

The public site is a static Astro app with a home page, `/setup`, `/privacy` and
`/terms`. It uses the shared theme, fonts, folder mark and printer favicon from
`packages/theme`.
It has no server, database or environment variables. A small browser script handles
copying the public setup prompt and dismissing its disclosure; assistant links and
manual prompt selection still work without JavaScript.

From the repository root:

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run --cwd apps/site dev
bun --no-env-file run --cwd apps/site check-types
bun --no-env-file run --cwd apps/site build
bun --no-env-file run --cwd apps/site format:check
```

Check that the default development port, 4321, is free before starting it. The
static build is written to `apps/site/dist`.

## Landing content

The home page explains working preferences, explicit save/read steps, and planned
launch pricing. Early access remains free; the site does not implement billing or
a trial clock. Update the pricing and expiry language together with the billing
release rather than implying payment controls already exist. `/setup` provides
client-specific guidance and links to official documentation; no connection is
created merely by visiting the guide. `AssistantSetup.astro` owns the shared public
setup prompt and encoded Claude/ChatGPT launch links. No account data goes into
the links. The providers control login and prompt handling; manual copying is the
fallback. The prompt requires approval before saving and preserves existing preferences.

Grok Bot, Muse and Claude Duet have documentation-based setup guides, explicitly
marked as not yet verified with Milton. Do not promote them as verified clients
until sign-in, reading, saving and reconnecting have passed in real client sessions.
The shared copy-prompt flow works as a manual starting point; no unverified
provider-specific prompt-prefill URLs are generated for these clients.

## Hosting

Vercel project `milton-site` serves `meetmilton.com`.
`meetmilton.com` redirects to `www.meetmilton.com` with HTTP 308. Cloudflare DNS
records point to Vercel with proxying disabled. Use the target returned by
Vercel's domain configuration for this project.

Project settings: Astro framework, root directory `apps/site`, build command
`bun run build`, output directory `dist`, and Node.js 26.x. This static site does
not need the Vercel Astro adapter.

The site pins TypeScript 6 because `astro check` does not support the root
workspace's TypeScript 7 yet.

Production publishes from main only. The Vercel project is linked to the GitHub
repository `zoneofdanger/milton` with `main` as the production branch: every push to
main builds and publishes the site, and a commit that touches none of `apps/site`,
`packages/theme`, the root `package.json` or `bun.lock` is skipped by the project's
ignored-build-step command. A branch can only produce a preview: build one with
`vercel deploy --project milton-site --scope zoneofdanger` (never `--prod`) from the
repository root, where `.vercelignore` allowlists `apps/site`, `packages/theme` and the
workspace manifests. Never promote a branch build; land it and let the push publish.

Do not reuse the web app's project link or copy its environment variables.
