---
name: releases
description: How a Milton release is built, deployed, verified, gated and rolled back on Cloud Run, and how Turnstile is switched on
type: procedure
covers:
  - server/deploy/app.service.json
  - server/deploy/mcp.service.json
  - server/Dockerfile
  - apps/auth/Dockerfile
  - server/scripts/probe-forms.ts
---

# Releases

Production releases are run by the release coordinator, `milton-duo`, with Peter's go
([publishing](../agents/publishing.md)). Each command here touches production. What is
serving now, the rollback targets and the floor are in [serving](serving.md); the
services and their settings are in [cloud](cloud.md); schema changes follow
[migrations](migrations.md). After a release, rewrite [serving](serving.md) and add the
release's record to [history](../history.md).

## Before a release

1. Validate the app and MCP with fictional data in an explicitly isolated environment.
   Never copy personal memos into staging.
2. Record the current revision IDs, image digests and numeric secret versions before a
   release (they should match [serving](serving.md)). Preserve those resources for
   rollback.
3. Run the usual Bun checks (types, tests, format) on the merged tree.

Do not delete validation or production resources as part of an ordinary release.

## Server image: app, MCP, admission and the daily check

One image runs `milton-app`, `milton-mcp` and `milton-admit` (`MILTON_SERVICE` picks the
role) and carries `server/dist/e2e.js` for `milton-e2e-daily`. Each image includes the app,
MCP and admit roles and the browser assets.

1. Build `server/Dockerfile` from the repository root for Linux amd64, push the image to
   `us-east4-docker.pkg.dev/milton-510506/milton/runtime` and record its digest. Verify the
   built artifact under Node 26. The container runs as the unprivileged `node` user and
   contains a self-contained runtime bundle. Do not copy local dependencies, environment
   files or private keys into the image.
2. **Admission first:** set the image digest in
   [admit.service.json](../../server/deploy/admit.service.json), which is kept at the serving
   image, and apply it with `gcloud run services replace server/deploy/admit.service.json`
   (`--dry-run` first; `--project=milton-510506 --region=us-east4`).
3. **App and MCP:** deploy the digest to `milton-app` and `milton-mcp` as a tagged revision
   with `gcloud run deploy --no-traffic`, check that revision, then move traffic with
   `gcloud run services update-traffic`. Note the UTC time traffic moved, for the release
   gate. When MCP's tools or answers change, follow [the order below](#when-mcps-tools-change).
4. **The daily check after the services:** move `milton-e2e-daily` to the same image with
   `gcloud run jobs update milton-e2e-daily --image=…@sha256:<digest>` (see
   [e2e](e2e.md#across-a-release)). A check on one image can fail against the other image's
   MCP, and the job pins its own image, so a service release or rollback does not move it.

## When MCP's tools change

A release that changes the tool list, a tool's arguments or a receipt keeps the daily check
out of the switch, and selects the services in this order. It needs no traffic split and no
closed ingress; no route or split may keep sending requests to the side being left.

1. **Stage every image first:** server, auth and the site's build, each pushed and
   recorded, no traffic moved.
2. **The daily check is idle.** `gcloud run jobs executions list --job=milton-e2e-daily`
   shows no active or pending execution; nobody starts one by hand until step 6; and the
   switch through step 6 finishes before the next scheduled run (`7 2,14 * * *` UTC).
   Otherwise defer.
3. **The new app** (with admission, on the same runtime image), then drain the old app:
   wait out its revision's request timeout and confirm in its request log that nothing
   reaches it.
4. **The new MCP**, then drain the old MCP the same way, database work included.
5. Any check the release's runbook asks for between the old writers draining and the first
   run on the new image (for memos and tweaks only, the test account's owner check,
   [e2e](e2e.md#across-a-release)).
6. **The job image**, `gcloud run jobs update milton-e2e-daily --image=…`, checked with
   `gcloud run jobs describe`, then one manual execution passing.
7. **The auth service**, on its own (service and both jobs together, as below).
8. **The site, last**: the release's site change merged to main publishes it ([site](../site.md)).

Then [verify](#verify) and run the release gate.

**Never apply `app.service.json` or `mcp.service.json` with `services replace`.** They are
not kept current: they still pin the pre-cutover release (app `milton-app-edit-00223ec` and
MCP `milton-mcp-edit-00223ec`, image index `sha256:2682542b…`, env 3, key 1), so replacing
from them would deploy that old code and those old secrets. Derive a manifest from the live
service if one is ever needed.

Zero-traffic revisions may report `Ready=True` with `Retired`; inspect the specific
revision and its imported image, then verify startup again when assigning traffic.

## Auth image: the service and both jobs

Build the auth image from `apps/auth/Dockerfile` as committed, from the repository root; its
base images are pinned by digest. An auth release moves `milton-auth`, `milton-auth-mail`
and `milton-auth-maint` to the same image in the same step. Keep `AUTH_ADMISSION_URL` (a plain variable on the service and the
mail job, see [cloud](cloud.md#admission-service-milton-admit)); the image refuses to start
in production without it.

- **Check the serving revision and move traffic with `update-traffic`.** A deploy of
  `milton-auth` once created the revision but left traffic on a tagged older revision
  (traffic named a revision, not latest; 2026-11-08, #71). Cloud Run records the image by
  its amd64 manifest digest, not the index digest, so compare by revision, not by digest.
- **Mail job with the service.** The Reply-To (`AUTH_MAIL_REPLY_TO`, default
  `support@meetmilton.com`) is bound into each encrypted message, so the mail job must run
  the same image as the service. A message the old image queued still sends under the new
  one; rolling the job back to an older image fails, as `failed`, any message the new image
  queued in the previous 15 minutes, so roll back service and job together.
- Auth's Cloud Run service must resolve public DNS (the default metadata resolver does):
  the mail domain check reads MX records.

## Verify

1. Verify canonical app/MCP TLS and health, MCP discovery and unauthenticated 401, CORS,
   HTTP 308 redirects and direct `run.app` refusal. Keep both canonical DNS A records at
   `35.227.244.36`, DNS-only, TTL 60, and preserve the certificate authorization CNAMEs.
   Never bypass TLS verification.
2. Verify an authenticated MCP read and the affected browser behavior when releasing
   application changes. Avoid synthetic writes to a real user's account; the test account
   ([e2e](e2e.md)) is the one that may be written.
3. After an app release, run `bun scripts/probe-forms.ts https://app.meetmilton.com` from
   `server/`. It posts a signed-out form the way Chrome does (`Origin: null`). `PASS`
   (exit 0) means the form reached the sign-in check; `FAIL` means `csrf_refused`, so roll
   back the app.
4. The usual live checks, as each release record lists them: health 200 on app, MCP and
   auth (`/api/auth/ok`), app home 200, MCP 401 unauthenticated, the forms probe, one manual
   `milton-e2e-daily` run passing
   (`gcloud run jobs execute milton-e2e-daily --project=milton-510506 --region=us-east4 --wait`),
   admit 403 without a token
   (`curl -s -o /dev/null -w '%{http_code}\n' -X POST https://milton-admit-419545871671.us-east4.run.app/internal/auth/admit`),
   and, after an auth release, UserInfo 401 on a junk token and `/login`, `/signup`,
   `/forgot-password` and `/reset-password` 200.
5. **Release gate.** Note the UTC time traffic moved, wait 10 minutes (the gate's 5-minute
   windows plus metric and log ingestion delay), then run one query:

   ```sh
   DEPLOYED=2026-11-08T04:26:00Z   # when traffic moved, UTC
   gcloud monitoring alerts list --project=milton-510506 --verbosity=error \
     --filter="state=\"OPEN\" OR open_time>=\"$DEPLOYED\"" \
     --format='table(state,openTime,policy.displayName,resource.labels)'
   ```

   No output passes. Any row (gate or page, open or opened since the deploy) means
   investigate before calling the release done; a gate row names its condition's service or
   job. The filter runs on the server (`state`, `open_time`, `policy.display_name`). This
   replaces the manual 5-minute watch. An alert whose policy was deleted can stay `OPEN`
   (seen 2026-11-08 with the delivery test's policy); judge such a row by its policy name.
   The gate's conditions are in [alerts](alerts.md). Also check that no request reached an
   older revision after traffic moved.

Connected AIs may keep showing old tool wording until they reconnect.

## Rollback

Roll back only affected services, preserve ingress/IAM, then repeat the canonical security
checks. For a schema-compatible code release, first verify the selected runtime supports the
current database schema and accounting policy, then send traffic to its recorded healthy
Cloud Run revision with `update-traffic`. **Do not restore or reset the database** to roll
back application code. An existing revision retains its image, runtime configuration and
numeric secret references.

**Where to roll back to.** Take the rollback target and the floor from
[serving](serving.md), never from a revision list: older revisions stay listed long after a
migration has made them unsafe. The floor moves when a migration drops something older code
reads (its `-- code-stopped-by: #NN` line names the change that stopped reading it); the
release that applies it records the new floor in [serving](serving.md). Revisions from before
the 2026-11-07 schema and auth cutover (`*-edit-00223ec` and older) cannot read the current
schema at all. Fix forward.

Inspect revision readiness before selecting the recorded revision:

```sh
gcloud run revisions list --service=milton-app --project=milton-510506 --region=us-east4
```

- Roll `milton-e2e-daily` back after app and MCP (it pins its own image), under the same
  conditions as forward: no active or pending execution, no manual start, the switch done
  before the next scheduled run, then one manual execution.
- Roll the auth service and both auth jobs back together (the mail note above).
- If a revision is no longer available, restore its saved service manifest with its pinned
  image and matching secret versions using the release procedure above.
- Do not restore the old Vercel CNAME: the project and its deployments no longer exist.

See [Google's revision rollback guide](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration).

### Rolling back memos and tweaks only

The release that retires `get_cover_sheet`, the cover sheet, notes written by AIs, rounds and
the tweak score runs after `0016` (applied 2026-11-12, [serving](serving.md#schema-heads)),
which only loosens checks, so the rollback is the previous revisions with no schema step.
It is a **degraded emergency fallback** (milton-overlord, 2026-11-12): writing is kept, and
memo pages, the export and deletion keep working, under two accepted limits, the scoreboard
on the [TPS page](../tps-page.md#scoreboard) and replay and fresh saves in
[saves](../saves.md). The rollback target is good until the later cleanup (revoking the
unused grants and dropping the retired tables and columns); after it, fix forward.

1. **The old MCP first**, then drain the new MCP's requests and database work, so no new
   memo is saved under the new code from here on.
2. **The query.** milton-duo runs it read-only. It lists every account that could then hit
   the old scoreboard's 503 (candidates, not proven failures); it is a snapshot, not
   clearance for later writes, which is why it runs only after step 1:

   ```sql
   SELECT user_id, mode, count(*) AS scored,
          count(*) FILTER (WHERE rounds IS NULL) AS without_rounds
   FROM memos
   WHERE first_draft_state = 'kept' AND change IS NOT NULL
   GROUP BY user_id, mode
   HAVING count(*) >= 10 AND count(*) FILTER (WHERE rounds IS NULL) > 0;
   ```

   No rows: go on. Any row: say so to Peter and choose between rolling back with the TPS
   page possibly answering 503 (and showing inaccurate rounds) for those accounts, and
   fixing forward. Record the limits taken with the degraded fallback in the release record.

3. **The old app** (with admission), then drain the new app.
4. **The job image**, under the forward conditions (no active or pending execution, no
   manual start, finished before the next scheduled run), then one manual execution.
5. **The previous auth revision**, then **the previous site deployment**.

After a rollback, AIs still holding the new contract may fail drafted saves even as fresh
saves until their tools refresh, and old reports, the old writing tools and the old export
return.

## Turnstile (separate go from Peter at release)

Off until both `AUTH_TURNSTILE_SITE_KEY` and `AUTH_TURNSTILE_SECRET_KEY` are in auth's
environment; the image starts with neither. To turn it on: create the widget for hostname
`auth.meetmilton.com` in Cloudflare; mint the next `milton-auth-env` version with the secret
key added (the site key is public and may go in the payload or as a plain variable); deploy
`milton-auth` with that pinned version. The mail and maintenance jobs do not need it. Then
load `/signup` (the widget renders, no CSP error in the console) and complete one real
sign-up; milton-auth's log should have no `auth_turnstile` line (each one is a siteverify
failure, logged with Cloudflare's code names or a fixed label; `http_error`, `network`,
`timeout` or a secret code mean egress or the secret, not visitors). Turning it off is
deploying without the keys.

- **Privacy page, same release:** in the release that turns Turnstile on, and not before,
  publish this text on the privacy page (`apps/site/src/pages/privacy.astro`) exactly as
  Peter approved it (2026-11-09), so it describes visits to `/signup`, including people who
  leave or choose Google/GitHub:

  > When you visit our sign-up page, Cloudflare Turnstile checks that you are a person;
  > Cloudflare receives your IP address and signals from your browser for that check.
  > Before sending a verification or reset email, the sign-in service checks your email
  > domain's DNS records, sending DNS only the domain, not your address.

- **Per-network limit:** with Turnstile on, email sign-up takes 3 in 10 s per client
  network, from the address Google's load balancer appends to `X-Forwarded-For`. Checked
  2026-11-09 (read-only): `auth.meetmilton.com` resolves to the Google load balancer
  (35.227.244.36, `server: Google Frontend`, no `cf-ray`), so it is not proxied by
  Cloudflare and the limit sees each real client. If auth is ever proxied through
  Cloudflare, that address becomes Cloudflare's, and every visitor behind one Cloudflare
  edge would share the limit: derive the client from Cloudflare's header first.
