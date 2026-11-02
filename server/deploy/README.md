# Hosting and release operations

Milton uses Bun for installs, builds and tests, and Node 26 LTS in production.

| Surface                                | Runtime and hosting                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| `meetmilton.com`, `www.meetmilton.com` | Static Astro, Vercel `milton-site`                                    |
| `app.meetmilton.com`                   | Hono JSX, Vite theme assets, Cloud Run `milton-app`                   |
| `mcp.meetmilton.com`                   | Hono MCP, Cloud Run `milton-mcp`, Google external HTTPS load balancer |
| Spend-alert worker                     | Private Cloud Run `milton-worker`, Cloud Scheduler `milton-gardening` |

Neon PostgreSQL and Neon Auth remain the source of truth. This move changes no
schema, compiler model, thinking setting, budget, memo, report, or refinement
Apply/Discard contract.

The app, MCP and worker are live on GCP. Vercel hosts only the static Astro site.
The retired combined Vercel `milton-mcp` project, deployments, aliases, project
secrets and firewall configuration were removed during the authorized hosting
decommission on 2026-11-01. Hosting rollback now uses Cloud Run revisions.

## Cloud resources

Project `milton-510506`, Cloud Run/Artifact Registry region `us-east4`, Scheduler
region `us-east1`. Service manifests in this directory pin an immutable image and
secret versions. They contain configuration and secret references, never values.
All three services use the memo-update release `552396e`, pinned to
`sha256:aeb85df35c7a2fec254dd6d95d82a6c7dc4a5dec47b383cb8f361d2722d7b0ee`.
The manifests explicitly select runtime `MILTON_GLOBAL_SPEND_POLICY=alerts_only`;
the locked SQL policy controls admission. Existing positive account safeguards
remain in effect. Trials and billing remain disabled.
Each image includes all roles and browser assets. Validate manifests before applying:

```sh
gcloud run services replace server/deploy/mcp.service.json --dry-run --project=milton-510506 --region=us-east4
gcloud run services replace server/deploy/worker.service.json --dry-run --project=milton-510506 --region=us-east4
gcloud run services replace server/deploy/app.service.json --dry-run --project=milton-510506 --region=us-east4
```

For a release, build `server/Dockerfile` from the repository root for Linux amd64,
push the image to `us-east4-docker.pkg.dev/milton-510506/milton/runtime`, record its
digest, update the manifests, validate, and replace the services. Run the usual
Bun type/tests first and verify the built artifact under Node 26. The container
runs as the unprivileged `node` user and contains a self-contained runtime bundle.
Do not copy local dependencies, environment files or private keys into the image.

The app and MCP services accept ingress only from internal sources and Google's load
balancer. Its platform invoker policy permits external MCP clients; Milton still
requires a valid Neon access JWT for each tool request, and checks the canonical
host. Direct public `run.app` access is refused. The worker uses internal ingress
and grants `roles/run.invoker` only to
`milton-scheduler@milton-510506.iam.gserviceaccount.com`. Never make it public or
trust an arbitrary Authorization header inside the application.

Each runtime service account can read only its own `milton-<role>-env` and
`milton-<role>-key` secrets. Only the app receives its browser cookie secret.
IAM grants can take time to propagate; a new principal may initially be denied.
Do not weaken ingress or IAM to work around that delay.

The shared edge retains the name `milton-mcp`: reserved IPv4, URL map, HTTPS proxy
and certificate map. App and MCP have separate serverless NEGs and backends named
`milton-app` and `milton-mcp`. The HTTPS forwarding rule is `milton-mcp-https`.
The certificate map has exact-host entries for app and MCP. Keep each current
certificate until its replacement is ACTIVE and verified. DNS authorization resources
are named `milton-app` and `milton-mcp`; their CNAME records must remain for renewals.
Use [https-routing.yaml](https-routing.yaml) for the two hostname backends.
Both backends set `Strict-Transport-Security: max-age=63072000` as a custom response
header, preserving the prior Vercel HTTPS policy. Keep that setting when replacing
backends; the source pages retain their own CSP, no-store and framing restrictions.
The HTTPS proxy uses SSL policy `milton-web`, minimum TLS 1.2 with the `RESTRICTED`
profile. This retains Vercel's TLS 1.2/1.3 and modern cipher boundary; Google's
unconfigured default also accepts TLS 1.0. Preserve the policy when replacing the proxy.

For a new edge, create the policy and attach it explicitly (the CLI version value is
`1.2`; the API reports `TLS_1_2`):

```sh
gcloud compute ssl-policies create milton-web --global --profile=RESTRICTED --min-tls-version=1.2 --project=milton-510506
gcloud compute target-https-proxies update milton-mcp --global --ssl-policy=milton-web --project=milton-510506
```

After propagation, verify TLS 1.0/1.1 refusal and trusted TLS 1.2/1.3 connections.
`milton-mcp-http` provides only a method-preserving 308 HTTPS redirect using
[http-redirect.yaml](http-redirect.yaml). Preserve the certificate DNS authorization
CNAMEs for both hostnames; update only `app` and `mcp` traffic records during cutover.
Apex, www and mail records stay unchanged. Validate URL maps with
`gcloud compute url-maps validate --global --load-balancing-scheme=EXTERNAL_MANAGED --source=<file>`
before importing them.

## Secrets

Use separate dotenvx keypairs for app, MCP and worker. Store encrypted payloads in
private, versioned release storage and the corresponding private keys in platform
secret stores. Keep `.env*` and `.env.keys` out of git, images, command arguments
and logs. Never add an application endpoint to extract nonexportable secrets.

- Cloud Run mounts `milton-<role>-env:<version>` at `/run/milton/.env`, sets
  `MILTON_ENCRYPTED_ENV_FILE` to that path, and receives `DOTENV_PRIVATE_KEY` from
  its own key secret. Pin numeric secret versions; changing `latest` would make
  rollback ambiguous.
- The static Vercel `milton-site` project has no runtime secrets. Do not copy
  app, MCP or worker credentials into its build settings. The deleted combined
  Vercel project's environment is no longer a recovery source.
- Cloud Run's app payload has a fresh cookie cache-signing key. Milton filters out
  the SDK's session-data cache and asks Neon to validate the existing session token;
  the upstream token and canonical app hostname remain unchanged. The auth fixture
  verifies session continuity across the key change. The old Vercel key was never
  exported. Do not change Neon's signing keys as part of a hosting release.
- The runtime fails closed on missing or invalid decryption. Platform variables
  take precedence, so audit duplicate names during rotation. Restart/redeploy after
  configuration changes; configuration is loaded once per process.

Use the installed dotenvx CLI with an explicit `--env-keys-file` when encrypting
outside the working directory. Pass secret values to platform CLIs through stdin
or protected files, never `--value` or shell arguments. Preserve each rollback
revision's image and numeric secret versions together with its configuration.

## Scheduler operations

The production job is
`projects/milton-510506/locations/us-east1/jobs/milton-gardening`. It invokes
`https://milton-worker-419545871671.us-east4.run.app/api/garden` with method GET,
OIDC audience `https://milton-worker-419545871671.us-east4.run.app`, and the dedicated
scheduler service account. Use a 180-second attempt deadline, a UTC schedule of
`* * * * *`, and zero retries. The worker has concurrency 1 and maximum 1 instance;
the database remains the correctness boundary.

Verify actual scheduled 200 responses in Cloud Logging and public worker refusal.
Only one production scheduler should be enabled. Before replacing a scheduler,
prepare the new job paused, pause the old job, and wait for its 180-second
execution/lease window to drain before enabling the replacement.

## Release verification and rollback

The current revisions are `milton-app-foundation-34da2c2`,
`milton-mcp-retrieval-on-2f52f22`, and `milton-worker-retrieval-on-2f52f22`.
Retrieval is enabled only for one explicitly enrolled requesting account, including
its baseline document indexing. Plain `get_tps_report({})` remains model-free;
optional task reads add bounded candidate guidance while retaining the full TPS.
Generated graph explanations and inferred precedence are not served. This release
also includes the separately committed compiler prompt fingerprint fix `841b1dc`.

The retrieval-disabled revisions `milton-mcp-retrieval-2f52f22` and
`milton-worker-retrieval-2f52f22` retain the same compatible image. The preceding
`milton-mcp-cue-5f393f2` (image `sha256:821c8af54a4e9c443039745db4b729f768b34492c0affc51c57c745f2e2c7430`)
and `milton-worker-errors-6a18c58` (image `sha256:d261b9f48a23fed827c38bd336683a2d192cb1eddc7180c74b22ce30f796811c`)
also remain available with their existing numeric secrets. Before rollback, disable
the enrollment and task flags and drain in-flight work; keep additive tables and
spending records. Do not restore a pre-provenance writer.

Both memo cues remain supported: “Did you get that memo?” and “Did you get the memo?”
request a fresh ordinary report. Served guidance does not prove every assistant
will invoke the tool or supply a task. Trials and billing remain off; migration
0012 is only the default-off schema/access prerequisite for 0013, with no trial
enrollment, notices or billing activation in this release.

App/MCP retain environment/key versions 1; the worker retains `milton-worker-env:2`
and `milton-worker-key:1`. Foreground queries and all three background derivation
classes share SQL reservation caps of $5/account/day and $20/global/day. Worker and
MCP receive the existing project custom role `miltonModelPredict`, containing only
`aiplatform.endpoints.predict`; this is project-scoped, not model-specific IAM.
The app receives no prediction grant. Runtime flags alone enroll nobody.

Migrations 0012/0013 were applied atomically after backup and draining the scheduler;
all 17 pre-existing table hashes were unchanged. The app and static site were not
deployed as part of this release. The task retrieval procedure was removed with the code; see
[derived-systems removal](#derived-systems-removal-0018).

Migrations 0010/0011 add accepted-change provenance and resumable graph batches.
The release verified all 16 prior table hashes unchanged. Existing numeric secret versions,
models and budgets are unchanged. Provenance is recorded for accepted writes through this
runtime; missing legacy request evidence is not reconstructed.

**Writer rollback boundary:** runtimes before 0010 can read the cards but do not record
accepted-change provenance. Do not restore app/MCP write traffic to them. Retain the
`foundation-34da2c2` images/revisions as the first provenance-aware recovery baseline and
forward-fix if necessary. Schema rollback parks evidence and requires writes to stay stopped
until forward recovery. Old worker revisions may disable derivations without changing sources.

Migration 0009 adds only derived caches. All 13 prior table hashes were unchanged after
the schema migration. A separately user-directed exact partition reorganized existing
complete bullets into instruction cards while retaining their original heading context,
order, and all original history. It intentionally changes TPS formatting through repeated
headings and inter-card separators, without a model rewrite.

The prior `milton-<role>-cards-5ac28b4` revisions, image
`sha256:ac93477a66f4ce8bf05237ee5e044e787517e540ca43c8d71a0b51bc25b6aafe`,
and role-specific environment/key versions 1 remain retained historical baselines,
not provenance-aware app/MCP writer rollback candidates.
Their worker configuration disables derivations; keep the additive schema in place
during application rollback. The first derivation worker remains retained but its broader
graph review exhausted the bounded allowance; prefer the corrected worker or the
derivation-disabled card baseline when recovering. An authenticated read through that
older runtime verified the reorganized card assembly before traffic moved to the new release.

For an incompatible coordinated schema release, stage the image with `gcloud run deploy --no-traffic`,
pause the scheduler, and temporarily set app/MCP ingress to `internal`. Confirm the
canonical endpoints refuse traffic, then drain the longest request/lease window
(at least 180 seconds for this configuration). Take a Neon snapshot and record exact
table hashes before using the normal migration runner. Keep traffic closed until
parity checks pass and all three matching runtime revisions are ready and selected.
Restore app/MCP ingress to `internal-and-cloud-load-balancing`, verify canonical
reads, then resume and verify the scheduler. This prevents capture and review by
stopping their entry points without changing the pinned encrypted settings.
For an additive, backward-compatible migration, foreground traffic may stay open when
source publication remains atomic and version-fenced. Pause background dispatch, take a
backup, check source parity, and verify the old runtime can still serve the resulting
source schema before selecting the new revisions.

Zero-traffic revisions may report `Ready=True` with `Retired`; inspect the specific
revision and its imported image, then verify startup again when assigning traffic.

1. Validate the app and private worker with fictional data in an explicitly
   isolated environment. Never copy personal memos into staging.
2. Record the current revision IDs, image digests and numeric secret versions
   before a release. Preserve those resources for rollback.
3. Verify canonical app/MCP TLS and health, MCP discovery and unauthenticated 401,
   CORS, HTTP 308 redirects, direct `run.app` refusal, and worker scheduling.
   Keep both canonical DNS A records at `35.227.244.36`, DNS-only, TTL 60, and
   preserve the certificate authorization CNAMEs. Never bypass TLS verification.
4. Verify an authenticated MCP read and the affected browser behavior when
   releasing application changes, then inspect 5xx/auth/queue-age metrics. Avoid
   synthetic writes to a real user's account.
5. After an app release, run `bun scripts/probe-forms.ts https://app.meetmilton.com`
   from `server/`. It posts a signed-out form the way Chrome does (`Origin: null`).
   `PASS` (exit 0) means the form reached the sign-in check; `FAIL` means
   `csrf_refused`, so roll back the app.

To roll back a release, first verify the selected runtime supports the current
database schema, accounting policy and job payloads, then send traffic to its recorded healthy Cloud Run
revision. After native instruction-card activity under migration 0008, these initial
memo-backed baselines are incompatible: use a card-compatible revision or a forward fix.
After activating migration 0014, pre-allowance runtimes are also incompatible:
disable enforcement and drain holds before choosing an accounting/alerts-only/capability-aware
revision, preserving ledger, triggers, history and current key revocation. Do not
restore a database snapshot to roll back application code. See the
[memo-update rollback procedure](../README.md#memo-update-allowance-and-reservation-alerts-0014)
and [card upgrade boundary](../README.md#instruction-card-upgrade-0008). An existing revision retains its image, runtime configuration and
numeric secret references. The following pre-card revisions are historical references, **not card-runtime rollback targets**:

| Service         | Revision                  | Image source | Secret versions                              |
| --------------- | ------------------------- | ------------ | -------------------------------------------- |
| `milton-app`    | `milton-app-00001-prp`    | `96911d7`    | `milton-app-env:1`, `milton-app-key:1`       |
| `milton-mcp`    | `milton-mcp-00001-j7l`    | `2d9209d`    | `milton-mcp-env:1`, `milton-mcp-key:1`       |
| `milton-worker` | `milton-worker-00001-wgm` | `2d9209d`    | `milton-worker-env:1`, `milton-worker-key:1` |

The first allowance-compatible release is the current baseline below; it is not an
independent older release. Future rollback targets must satisfy the compatibility
boundary above. Inspect revision readiness before selecting a recorded revision:

```sh
gcloud run revisions list --service=milton-app --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-app --to-revisions=milton-app-allowance-552396e=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-allowance-552396e=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-allowance-552396e=100 --project=milton-510506 --region=us-east4
```

Previous release: `milton-app-readable-c3f29ab`, `milton-mcp-readable-c3f29ab`, and
`milton-worker-readable-c3f29ab` (image `sha256:6919b94b…`, built from main `c3f29ab`,
unchanged secret versions; worker env3/key1). Migration 0016 was applied (journal 17,
snapshot `snap-frosty-resonance-b8szumz6`). MCP later moved to `milton-mcp-samples-136bca5`
(image `sha256:14da29aa…`, built from main `136bca5`, switched 15:27Z) and then
`milton-mcp-titles-3898710` (image `sha256:049f2b8d…`, built from main `3898710`, switched
15:36Z); they changed only the MCP instructions, the `save_memo` description, and the save
compiler. Platform settings keep task guidance, gardening, and embeddings/graph off: MCP
sets `MILTON_TASK_RETRIEVAL_ENABLED=false` and `MILTON_GARDENING_ENABLED=false`; the worker
also sets `MILTON_DERIVATIONS_ENABLED=false`. Stored derived data is kept. The production
account's groups are titled.

Reports release: all three services serve `milton-app-reports-617e581`,
`milton-mcp-reports-617e581`, and `milton-worker-reports-617e581` (image `sha256:a0cb26d5…`,
built from main `617e581`, traffic switched by Peter 2026-11-02 16:25Z) with configuration
identical to the previous revisions apart from the image, so the platform settings above
still apply. Migration 0017 was applied at 16:23Z (journal 18, snapshot
`snap-muddy-bar-b8zypwnx`); it is additive and compatible with the previous runtime. The new
tools `get_cover_sheet`, `get_report`, `list_reports`, and `create_memo` replace
`get_tps_report` and `save_memo`. Update or remove any client hook that still calls
`get_tps_report`: it calls a retired tool. Rollback to the previous revisions:

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-readable-c3f29ab=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-titles-3898710=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-readable-c3f29ab=100 --project=milton-510506 --region=us-east4
```

Previous revisions (`milton-app-allowance-552396e`, `milton-mcp-extras-off-552396e`,
`milton-worker-email-db37798`) still start on the 0017 schema and serve the stored report
text, but they assemble without group titles or reports, ignore samples, and expose the
retired tools. A save under them would file cards without a report. Prefer a forward fix;
if a rollback is unavoidable, keep it short and let the first read on a current revision
reassemble afterwards. The previous worker revision also re-enables embeddings/graph and
gardening.

Whenlines release: revisions `milton-app-whenlines-5619ff8`,
`milton-mcp-whenlines-5619ff8`, and `milton-worker-whenlines-5619ff8`. Peter
switched traffic to them at 2026-11-02 16:45Z. They run image
`sha256:80a5d46f…`, built from main `5619ff8`, with configuration identical to the
reports revisions apart from the image. They add no migration. Changes: report when lines
read as sentences in the index and the report, and a saved sample charges one memo update.

Rollback to the reports revisions:

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-reports-617e581=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-reports-617e581=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-reports-617e581=100 --project=milton-510506 --region=us-east4
```

Kitcap release: revisions `milton-app-kitcap-1054255`, `milton-mcp-kitcap-1054255`,
and `milton-worker-kitcap-1054255`. The agent switched traffic to them at
Peter's explicit request at 2026-11-02 18:32Z. They run image
`sha256:f53e91de…`, built from main `1054255`, with configuration identical to the
whenlines revisions apart from the image. They add no migration. Changes: the kit report
cap matches the server's 256 KB and the kit MCP wrapper cap is 1 MiB; an empty report keeps
its heading; and the trial notice claim waits for its result.

Rollback to the whenlines revisions (image `sha256:80a5d46f…`; no migration step):

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-whenlines-5619ff8=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-whenlines-5619ff8=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-whenlines-5619ff8=100 --project=milton-510506 --region=us-east4
```

Mcpinstr release: MCP only. Revision `milton-mcp-mcpinstr-570fd0f`; the agent
switched MCP traffic to it at Peter's explicit request at 2026-11-02 18:47Z, and it served
100%. It runs image `sha256:eac4b6a8…`, built from main `570fd0f`, with configuration
identical to `milton-mcp-kitcap-1054255` apart from the image. App and worker stayed on the
kitcap-1054255 revisions. No migration. Change: the MCP server instructions are 3,792
characters, within Claude Code's 4,096-character limit. The release also removes the agent
kit's hook installer, which is not part of the server runtime.

Rollback to the kitcap MCP revision (image `sha256:f53e91de…`; no migration step):

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-kitcap-1054255=100 --project=milton-510506 --region=us-east4
```

Derived release: revisions `milton-app-derived-cba4f6c`, `milton-mcp-derived-cba4f6c`,
and `milton-worker-derived-cba4f6c`. The agent switched traffic to them at Peter's
explicit request at 2026-11-02 20:03Z; each serves 100%. They run image
`sha256:6b9efbf7…`, built from main `cba4f6c`, which removes the derived systems.
Migration 0018 was applied at 2026-11-02 20:10Z (Drizzle journal 19) after Neon snapshot
`before-0018-derived` (`snap-dark-paper-b89g9wif`); all 19 retained tables were unchanged.
MCP drops `MILTON_TASK_RETRIEVAL_ENABLED` and `MILTON_GARDENING_ENABLED`; the
worker drops those and `MILTON_DERIVATIONS_ENABLED` and `MILTON_GLOBAL_SPEND_POLICY`; app
configuration is unchanged apart from the image. Secret versions are unchanged (app/MCP
env 1, key 1; worker env 3, key 1). At 20:04Z the first scheduled worker tick returned
200, an authenticated `get_cover_sheet` returned 200 with an unchanged version,
unauthenticated `/mcp` returned 401, discovery and the app returned 200, and logs showed
no errors or 5xx.

Since 2026-11-02 20:22Z the worker serves `milton-worker-env4-cba4f6c` at 100% (same
image as `milton-worker-derived-cba4f6c`), switched by the agent at Peter's explicit
request. It mounts `milton-worker-env:4`, which is version 3 without
`MILTON_GEMINI_API_KEY`, `MILTON_GEMINI_PROJECT_ID` and the four gardening and derivation
budget keys; `milton-worker-key:1` is unchanged. The first scheduled tick at 20:23Z returned
200 with no errors. The revision also carries an unmounted leftover volume referencing
version 3, as gcloud leaves it. At 20:18Z the project role `miltonModelPredict` was
removed from the MCP and worker service accounts; no bindings remain and the role
definition is kept. The compiler authenticates with `MILTON_GEMINI_API_KEY`, not the
service account; a compiler save on the next real memo is still to be verified.

Rollback after 0018: app and MCP may return to the kitcap and mcpinstr revisions. The
worker returns first to `milton-worker-derived-cba4f6c` (env version 3, still enabled);
the kitcap worker would return 503 every minute while still publishing alerts, so prefer a
forward fix. Schema rollback is `server/drizzle/rollback/0018_remove_derived.sql` (empty
shape, extension included); data only from the snapshot restored to a separate branch. See
[derived-systems removal](#derived-systems-removal-0018).

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-kitcap-1054255=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-mcpinstr-570fd0f=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-derived-cba4f6c=100 --project=milton-510506 --region=us-east4
# Last resort after 0018 (503 on every scheduled call):
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-kitcap-1054255=100 --project=milton-510506 --region=us-east4
```

Accounts release: revisions `milton-app-accounts-0db5baa`, `milton-mcp-accounts-0db5baa`,
and `milton-worker-accounts-0db5baa`. The agent switched traffic to them at Peter's
explicit request on 2026-11-02 (app 21:15:22Z, MCP 21:15:31Z, worker 21:15:39Z); each
serves 100%. They run image
`sha256:56ff6f744d0d45cf3a3f558670bb6bdb7f8532a50b0803ec807875e1e5d76c35` (amd64
`sha256:6d163f7b…`; uid 1000, Node 26, no env, key or pem files), built from main
`0db5baa`, which adds assistant disconnects and account deletion. Configuration is
identical to the derived-cba4f6c (app, MCP) and env4-cba4f6c (worker) revisions apart from
the image; secret versions are unchanged (app/MCP env 1, key 1; worker env 4, key 1).
Migration 0019 was applied at 2026-11-02 20:42Z (Drizzle journal 20) after Neon snapshot
`before-0019-accounts` (`snap-weathered-night-b8sgxftt`, 20:41:48Z). It is additive, so
the scheduler kept running. It created `assistant_disconnects` and `deleted_identities`
empty; 18 of the 19 existing tables were unchanged and `usage_daily` moved by one read
counter only. From 21:15Z to 21:26Z the app, MCP health and discovery returned 200,
unauthenticated `/mcp` returned 401, HTTP redirected with 308, TLS 1.2 and 1.3 were
accepted and TLS 1.0 and 1.1 refused (SSL policy `milton-web`, minimum TLS 1.2), the
`run.app` URL returned 404, an authenticated `get_cover_sheet` returned 200 with an
unchanged version, ten scheduled worker ticks returned 200 on the new worker, and logs
showed no errors or 5xx. The disconnect and deletion paths were not exercised in
production.

Rollback after 0019 (image `sha256:6b9efbf7…`; no migration step). The pre-0019 runtime
ignores the refusal table, so disconnected assistants regain access until traffic moves
forward again. Keep both tables. Never restore the `before-0019-accounts` snapshot to roll
back code.

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-derived-cba4f6c=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-derived-cba4f6c=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-env4-cba4f6c=100 --project=milton-510506 --region=us-east4
```

Now serving (since 2026-11-02 22:29:13Z): MCP `milton-mcp-rules-env2-e3f2f67`, app
`milton-app-forms-92975ff`, worker `milton-worker-filing-f505745`; both are recorded below.

Current release: revisions `milton-app-filing-f505745`, `milton-mcp-filing-f505745`, and
`milton-worker-filing-f505745`. MCP and worker still serve them; since 22:00:35Z the app
serves the forms-92975ff hotfix below. They run image
`sha256:a370b7c3f414560141d345e31ca84c329c5ad51c692eb526af6d16329feddd62` (amd64
`sha256:169ab9e4383e3c7a27b67e6da6b6e5ef2c3de75949f7e73fffba3a9a98b0b005`; uid 1000, Node 26,
no env, key or pem files; build stage `oven/bun:1.4.4`), built from main `f505745`, which
moves each card's report onto its versions and gives samples stable kinds. Configuration is
identical to the accounts-0db5baa revisions apart from the image; secret versions are
unchanged (app/MCP env 1, key 1; worker env 4, key 1). The runtime requires migration 0020,
so the window on 2026-11-02, with Peter's go, ran: scheduler paused 21:30:32Z; Neon snapshot
`before-0020-filing-kinds` (`snap-sparkling-hall-b8lhiunz`); 0020 applied at 21:30:43Z
through `migrateStore` from the `f505745` tree (Drizzle journal 20 to 21); traffic switched
to MCP at 21:30:56Z (about six seconds after the migration committed), app at 21:31:06Z and
worker at 21:31:15Z; scheduler resumed 21:31:16Z. Each serves 100%. All 18 tables 0020 does
not touch kept identical counts and hashes. All 94 card versions carry a report (heads cover
22, email 14, chat 3; no card mixes reports) and `instruction_cards.report` is gone. Both
active samples have kinds (chat "connection request", email "follow-up email"),
`sample_kinds` holds 2 rows and `samples.kind` is gone. After the switch, unauthenticated
`/mcp` returned 401, discovery and the app returned 200, an authenticated `get_cover_sheet`
returned 200 with an unchanged version, and `get_report("email")` returned the sample with
its `kind_id` and kind. From 21:30Z to 21:42Z ten scheduled worker ticks returned 200 on the
new worker and logs showed no errors or 5xx; the accounts-0db5baa revisions returned no 5xx
during the gap.

Rollback after 0020 (image `sha256:56ff6f74…`). No pre-0020 app or MCP revision can serve
reads or saves. To return to the accounts-0db5baa revisions, stop writers (pause the
scheduler), run `server/drizzle/rollback/0020_filing_kinds.sql`, then shift traffic. The
rollback is lossy: each card keeps only its latest report, and retirement reasons and
replacement links are dropped (none exist yet). The 0020 journal row stays, so re-forwarding
means running `0020_filing_kinds.sql` by hand. Never restore the `before-0020-filing-kinds`
snapshot to roll back code. See [filing moves and sample kinds](#filing-moves-and-sample-kinds-0020).

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-accounts-0db5baa=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-accounts-0db5baa=100 --project=milton-510506 --region=us-east4
gcloud run services update-traffic milton-worker --to-revisions=milton-worker-accounts-0db5baa=100 --project=milton-510506 --region=us-east4
```

App hotfix forms-92975ff: app only. Revision `milton-app-forms-92975ff`; milton-product
switched app traffic to it at 2026-11-02 22:00:35Z at milton-lead's relay of Peter's go,
and it serves 100%. MCP and worker stay on the filing-f505745 revisions. It runs image
`sha256:8dc1a5a818f099021e0ba1ff84f2ada4340cc138013782a880d4d0e35bbb33ef` (amd64
`sha256:1c6d4ea5396b9f20e6b7a3c371ff6f6c7035311b6ece5bf5b40e810021beb6ae`; uid 1000, Node 26,
no env, key or pem files), built from main `92975ff`, with configuration identical to
`milton-app-filing-f505745` apart from the image (`milton-app-env:1`, `milton-app-key:1`).
No migration. Defect and fix: behind Cloud Run the server saw its own URL as `http://`, so
every browser form POST was refused with `csrf_refused` from 2026-11-01; `cloud-app.ts` now
rebuilds the request at the configured app origin after the canonical-host check. Before the
switch, `bun scripts/probe-forms.ts https://app.meetmilton.com` printed `FAIL` with
`csrf_refused` (the defect reproduced); after it, the probe printed "PASS: form post reached
the sign-in check (403)" with exit 0, and the app and `/login` returned 200. From 22:00Z to
22:11Z the new revision served 37 requests with no 5xx and no error logs.

Rollback to the filing app revision (image `sha256:a370b7c3…`; no schema change involved;
restores the form defect):

```sh
gcloud run services update-traffic milton-app --to-revisions=milton-app-filing-f505745=100 --project=milton-510506 --region=us-east4
```

MCP release rules-e3f2f67 (model-free saves): MCP only. Revision `milton-mcp-rules-e3f2f67`,
staged with `--no-traffic`; milton-product switched MCP traffic to it at 2026-11-02
22:14:43Z at milton-lead's relay of Peter's go, and it serves 100%. App stays on
`milton-app-forms-92975ff`, worker on `milton-worker-filing-f505745`. It runs image
`sha256:14147524680a2ce6aa4967345b8606859af1ea9845c6f84c2d379b545356da57` (amd64
`sha256:7737acde73b39b6a0dc99d025cc2d64d32f535c2632a2f8ad920dd5068ec87b7`; uid 1000, Node 26,
no env, key or pem files; the bundle has no `compiler.ts`, `generativelanguage` or
`MILTON_GEMINI` strings), built from main `e3f2f67`, with configuration identical to
`milton-mcp-filing-f505745` apart from the image (`milton-mcp-env:1`, `milton-mcp-key:1`;
env variables unchanged, including `MILTON_GEMINI_PROJECT_ID` and
`MILTON_GLOBAL_SPEND_POLICY`). No migration. Change: `create_memo` stores the assistant's
`rules` (`{report, text}`) and refuses a text-only save with `invalid_input`; the Gemini
compiler and model budgets are gone from the runtime. After the switch, unauthenticated
`/mcp` returned 401 and discovery 200; an authenticated `get_cover_sheet` returned 200 with
an unchanged version; `get_report("email")` was byte-identical to the pre-switch read; a
text-only `create_memo` was refused with `invalid_input` ("Name the report and send the
rule's text in rules.") with no receipt row and no charge. From 22:14Z to 22:25Z the new
revision served 33 requests with no 5xx and no error logs, and worker ticks returned 200.

Rollback to the filing MCP revision (image `sha256:a370b7c3…`; no schema change involved). A
save that sent `rules` cannot replay on that older runtime:

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-filing-f505745=100 --project=milton-510506 --region=us-east4
```

MCP secret follow-up rules-env2-e3f2f67: since 2026-11-02 22:29:13Z MCP serves
`milton-mcp-rules-env2-e3f2f67` at 100% (same image as `milton-mcp-rules-e3f2f67`), switched
by milton-product at milton-lead's word. It mounts `milton-mcp-env:2`, which is version 1
without `MILTON_GEMINI_API_KEY`, `MILTON_GEMINI_PROJECT_ID`, `MILTON_MODEL_ACCOUNT_BUDGET_USD`
and `MILTON_MODEL_GLOBAL_BUDGET_USD`, and drops the plain `MILTON_GEMINI_PROJECT_ID` variable;
`milton-mcp-key:1` is unchanged. The unread `MILTON_GARDENING_ENABLED` stays in the payload
until a later version, and the revision carries an unmounted leftover volume referencing
version 1, as gcloud leaves it. After the switch, unauthenticated `/mcp` returned 401,
discovery 200 and an authenticated `get_cover_sheet` 200; no `miltonModelPredict` binding
remains on any service account. Rollback of the secret change returns to
`milton-mcp-rules-e3f2f67` (version 1 stays enabled); rollback of the code change returns to
`milton-mcp-filing-f505745` as above, where a save that sent `rules` cannot replay.

```sh
gcloud run services update-traffic milton-mcp --to-revisions=milton-mcp-rules-e3f2f67=100 --project=milton-510506 --region=us-east4
```

Roll back only affected services, preserve ingress/IAM and the enabled production
scheduler, then repeat the canonical security and scheduled worker checks. If a
revision is no longer available, restore its saved service manifest with its
pinned image and matching secret versions using the release procedure above.
**Do not restore or reset the database.** Do not restore the old Vercel CNAME:
the project and its deployments no longer exist. At decommission each production
service had only its initial revision; these are baselines for future release
rollback, not an older application release or independent-provider failover.
See [Google's revision rollback guide](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration).

The one-off migration validation services `milton-mcp-validation` and
`milton-worker-validation`, paused scheduler `milton-gardening-validation`, and
their dedicated validation secrets/service accounts were also decommissioned.
Their image and private evidence remain available. The isolated Neon validation
project `cold-recipe-45005130` remains intact and auto-suspends; it contains no
production copies. Recreate isolated hosting explicitly for future validation,
with any new validation scheduler paused outside checks. Do not delete validation
or production resources as part of an ordinary release.

## Memo-update activation (0014)

Apply the additive migration with enforcement disabled, after a database snapshot
and a quiescent worker/source baseline. Verify exact source, history, TPS and
receipt preservation and the initial foreground reservation aggregate. Deploy all
three compatible runtimes before selecting `policy --compatible-writers` and
enabling the prospective 100 successful updates/account/UTCday allowance. The
existing observer publishes aggregate threshold events independently of model work;
its failure cannot stop service. Global thresholds are alerts-only, with existing
per-account safeguards retained. No new retrieval enrollment or trial activation
is part of this release. See the operator commands in [server README](../README.md).

The capability feed remains unprovisioned until applicable platform, ingress and
inherited logging routes are verified not to persist its bearer URL. An accepted
local route or project-only log exclusion does not establish that condition.
Do not run `spend-feed rotate --logging-verified` without that evidence. Stored
alert publication does not prove Duet polling, notification or delivery.

## Spend-alert email activation (0015)

The private worker now serves `milton-worker-email-db37798` at 100% traffic,
from source `db37798a5a349b1dee14cedffd440237a617becd`, pinned to image
`sha256:4e29c0a745bd0bd7d9a449804624e1aeaa0fb45bf3811f78326e53036231aaef`.
It uses `milton-worker-env:3` and `milton-worker-key:1`. The encrypted payload
preserves the prior settings and adds the three Resend email settings described
in [server README](../README.md). This release changes only the worker; it does
not activate trials or change account limits, source instructions or enrollment.

Migration 0015 adds the durable email ledger after database snapshot
`snap-patient-bread-b8rnidyc`; all 23 preexisting tables and store configuration
were preserved exactly. The sending domain is verified. A labeled test email
was delivered, and an identical retry returned the same provider email ID.
Scheduled requests on the new worker returned 200; canonical production checks
passed. A genuine spending-threshold crossing was not manufactured for this test.

To stop new email dispatch, return worker traffic to the retained compatible
`milton-worker-allowance-552396e` revision (image
`sha256:aeb85df35c7a2fec254dd6d95d82a6c7dc4a5dec47b383cb8f361d2722d7b0ee`,
`milton-worker-env:2`, `milton-worker-key:1`). Preserve current operational pause
flags if they have since changed. Keep the additive email ledger, frozen payloads,
provider account, numeric secret versions and alert history. Do not restore the
database or delete delivery rows to retry an alert. The down migration refuses a
populated ledger; uncertain sends past the bounded retry window require manual
reconciliation rather than a fresh idempotency key.

## Derived-systems removal (0018)

Code released; migration 0018 applied. The code removes embeddings, advisory graphs, task-aware retrieval
and gardening review; the worker and scheduler `milton-gardening` (GET `/api/garden`)
stay for spend-alert publication and email. The four MCP tools and model-free reads
are unchanged. Migration 0018 refuses an unexpired gardening lease, deletes remaining
`gardening_jobs` rows (reconciling `users.retained_bytes`), and drops that table,
`card_links`, `card_graphs`, `card_retrieval_embeddings`, `retrieval_enrollments`,
`card_embeddings`, their two trigger functions, the four `store_config` derivation
columns with their checks, and the `vector` extension. `gardening_usage` and
`derivation_usage` stay as frozen ledgers because spend totals read them.

1. Rehearse 0018 on a disposable Neon branch of production before any production change.
2. Release the new image to app, MCP and worker together, staged with `--no-traffic`.
   Manifests drop `MILTON_TASK_RETRIEVAL_ENABLED`, `MILTON_GARDENING_ENABLED`,
   `MILTON_DERIVATIONS_ENABLED` and the worker's `MILTON_GLOBAL_SPEND_POLICY`. The new
   code references no removed object, so it runs on the pre-0018 schema.
3. Soak: scheduled worker 200s, spend-alert observation, an authenticated read, and one
   save only if Peter authorizes it.
4. Pause the scheduler and wait 180 seconds, take a Neon snapshot, record table hashes,
   apply 0018 with the normal runner, confirm every retained table is unchanged, then
   resume the scheduler and verify a scheduled 200.

**Rollback boundary.** Before 0018, any service may return to its kitcap, mcpinstr or
whenlines revision. After 0018, app and MCP may still return to those revisions, which
run with gardening disabled. A worker returned to kitcap keeps publishing alerts and
email, because the two ledgers remain, but fails on the missing `gardening_jobs` and
returns 503 to every scheduled call; prefer a forward fix. Older worker revisions,
including `milton-worker-email-db37798` and `milton-worker-allowance-552396e`, are not
rollback targets after 0018. The 0018 rollback script recreates the dropped objects
empty, extension included; the enrollment row, graph and link text, and caches are
recoverable only from the pre-0018 snapshot. Do not restore the database to roll back code.

A later release removes the spend-total branch that reads `gardening_usage` and
`derivation_usage`, and a migration then drops both, no earlier than 31 days after
their newest row. That ledger drop is the remaining follow-up.

Done: the `miltonModelPredict` grant was removed from the worker and MCP service accounts
on 2026-11-02 at 20:18Z (role definition kept), and `milton-worker-env:4`, without the
Gemini and derived budget keys, has served the worker since 2026-11-02 20:22Z. Versions 1
to 3 remain enabled. The unread `MILTON_GARDENING_ENABLED` and
`MILTON_DERIVATIONS_ENABLED` keys stay in the payload until a later version.

Status: Applied 2026-11-02 20:10Z (journal 19, snapshot `before-0018-derived`).

## Filing moves and sample kinds (0020)

Applied 2026-11-02 21:30:43Z (journal 21, snapshot `snap-sparkling-hall-b8lhiunz`).
Migration 0020 moves each card's report onto its versions and gives
samples stable kinds, dropping `instruction_cards.report` and `samples.kind` in the
same step. Every production revision before 0020 reads both columns, so release in
this order: stop writers, apply 0020, then shift traffic to the 0020 code.

**Rollback boundary.** After 0020, no pre-0020 app or MCP revision can serve reads or
saves. To roll Cloud Run back to one, first run `server/drizzle/rollback/0020_filing_kinds.sql`
offline with writers stopped, then shift traffic. The rollback is lossy: each card
keeps only its latest version's report, and retirement reasons, retiring request IDs
and replacement lineage are dropped (see the server README). It leaves the 0020
journal row in place, so re-forwarding means running `0020_filing_kinds.sql` by hand,
not the normal runner.

## Model-free saves

Released to MCP as `milton-mcp-rules-e3f2f67` on 2026-11-02 at 22:14:43Z (see the release
records). This code release removes the model from the write path: `create_memo`
stores the assistant's exact `rules`, `exact_edits`, `moves` and samples, and refuses a
save with only `text`. MCP is the only service whose behavior changes; there is no
migration. The runtime no longer reads `MILTON_GEMINI_API_KEY`,
`MILTON_GEMINI_PROJECT_ID`, `MILTON_MODEL_ACCOUNT_BUDGET_USD`,
`MILTON_MODEL_GLOBAL_BUDGET_USD` or `MILTON_GLOBAL_SPEND_POLICY`. Since 22:29:13Z it
runs with `milton-mcp-env:2`, version 1 without those four `MILTON_GEMINI_*` and
`MILTON_MODEL_*` keys, and without the plain `MILTON_GEMINI_PROJECT_ID` variable; version 1
stays enabled for rollback, and the unread `MILTON_GARDENING_ENABLED` stays in the payload.
No `miltonModelPredict` binding remains on any service account. Rollback is a traffic shift to the
previous 0020 MCP revision; no pre-0020 revision is a target. Receipts from that
revision replay on this one, but a save that sent `rules` cannot replay there, because
its input schema refuses the field.

The worker, scheduler, spend alerts and their email, `foreground_usage`, the global
spend policy column and the now unread `MILTON_GLOBAL_SPEND_POLICY` manifest variables
stay until the cleanup release timed with the 0018 ledger drop.
