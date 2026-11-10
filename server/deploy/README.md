# Hosting manifests

This folder holds the Cloud Run service manifests, the edge routing files and the alerts as
code (`monitoring/`). How they are used is in [docs/deploy](../../docs/deploy/):
[releases](../../docs/deploy/releases.md) (build, deploy, verify, the release gate,
rollback), [migrations](../../docs/deploy/migrations.md) (including database recovery),
[cloud](../../docs/deploy/cloud.md), [alerts](../../docs/deploy/alerts.md),
[e2e](../../docs/deploy/e2e.md) and [stripe](../../docs/deploy/stripe.md). What is serving
now is in [serving](../../docs/deploy/serving.md); past releases are in
[history](../../docs/history.md).

Never apply `app.service.json` or `mcp.service.json` with `services replace`: they pin the
pre-cutover release ([releases](../../docs/deploy/releases.md#server-image-app-mcp-admission-and-the-daily-check)).

The alert policies' documentation cites "Release verification and rollback" in this file:
that is now [releases](../../docs/deploy/releases.md#rollback). Older pointers into this
file (such as "Legacy schema cleanup" in `server/drizzle/0000_baseline.sql`) are in git
history: `git show 492b96a:server/deploy/README.md`.
