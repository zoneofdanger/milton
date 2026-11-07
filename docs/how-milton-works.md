# How Milton works

This is every piece of logic in Milton, one line each, so you can skim how it works.
Each section names the files it describes. When a change alters what a line says, update
that line in the same commit. Add a line for new behavior, and delete the line when the
behavior goes.

This file covers logic only. It leaves out the wording of setup questions, page copy,
CSS, and tests. For deployment steps, see [the hosting runbook](../server/deploy/README.md).
Live settings, such as whether trials are on, are held in the database and not recorded
here.

## Hosting and startup

Files: `server/src/cloud-run.ts`, `server/src/environment.ts`, `server/src/config.ts`,
`server/Dockerfile`, `server/deploy/`, `apps/site/vercel.json`.

- One Docker image runs as two Cloud Run services, and `MILTON_SERVICE` picks `app` or
  `mcp`.
- The prepared auth service has its own canonical host, issuer and database role; app/MCP routing stays separate. Live routing changes require the release runbook.
- HTTP upgrades to HTTPS with a redirect that keeps the method.
- Vercel builds the static site from main on every push.
- Startup decrypts a dotenvx file using a separate platform-held key.
- Startup fails on bad URLs, a missing/short app client, admission or eligibility secret, a bad support email, a bad port, or an
  unknown service name.
- Auth startup checks its runtime role before listening; connection failures retry with backoff for about 15 seconds, while a role refusal fails at once. App/MCP startup does no database work.
- Plain HTTP is allowed only on loopback outside production.
- On SIGTERM the server stops accepting requests and force-exits after 8 seconds.
- The image builds with Bun, then ships only the bundle and public assets to a non-root
  Node container.

## Every HTTP request

Files: `server/src/index.ts`, `server/src/cloud-app.ts`, `server/src/http.ts`,
`server/src/assets.ts`, `server/src/error-log.ts`, `server/src/pages.tsx`,
`server/src/billing.tsx`.

- A request is refused unless its Host matches that service's canonical host.
- The app rewrites each URL to its configured origin, because TLS ends upstream.
- Bodies over 256 KiB get a 413 before parsing, auth, or database work.
- The Stripe webhook keeps its own bound, also 256 KiB.
- `/mcp` goes to the MCP handler on the MCP service and returns 404 on the app.
- `GET /health` returns ok.
- `/.well-known/oauth-protected-resource` publishes the resource and its auth issuer.
- Any other path on the MCP host redirects to the app host with a 308.
- Static files are served from a fixed list of five, never arbitrary paths.
- Errors that escape the routes show browsers a "PC LOAD LETTER" page, and everything else
  gets a JSON 503.
- Error logs hold only the location, class name, and code, never messages or tokens.

## An MCP call

Files: `server/src/handler.ts`, `server/src/token.ts`, `server/src/mcp.ts`,
`server/src/mcp-outcomes.ts`, `server/src/store/index.ts`.

- Only POST and OPTIONS pass.
- Origin is deliberately not checked, so web clients reach auth from any origin. The Host
  check stops DNS rebinding and tokens authenticate every call, but this departs from the
  MCP spec's rule that servers validate Origin.
- JOSE checks EdDSA at+jwt against the exact configured issuer and MCP audience; native's fixed implicit UserInfo audience is allowed only with openid, and JWKS keys cache for 10 minutes.
- Tokens require matching client_id/azp, supported scopes and original binding/incarnation/generation; ID/session JWTs and confirmation/DPoP are refused.
- Every call checks live immutable native binding status; invalid/inactive is 401, real status/key outage is 503, with no stale-positive fallback.
- All three reads require milton:read; create_memo requires read+write, including direct calls. Read grants list three tools; write grants list four.
- Read-only setup explains reconnecting for saves; scope never establishes approval of memo text.
- A bad token gets a 401 that points the client to the sign-in metadata.
- Each request looks up the active writing account by exact verified issuer and subject; MCP never provisions an account.
- Each request builds a fresh stateless MCP server, with no sessions or subscriptions.
- Global instructions require retrieval before writing or editing for or as the person; only new drafts get the sample/rule conformity check before display. Edits preserve source wording and style outside the request over conflicting samples/rules; guidance never widens scope, and only specific unresolved conflicts are flagged. Requested transformations retain their scope, and changes are briefly listed. These are behavioral instructions, not server enforcement.
- After draft or edit approval, assistants display an exact placeholder-safe body and useful non-private context, then offer once to retain that proposal; one yes approves the displayed proposal. Every sample save requires that display, without silently redacting after approval or changing the working edit for retention. Change lists are excluded, refusal is final for that text, and only changed text/context requires renewed approval. Edits do not imply standing rules.
- Session capture requires explicit opt-in for the current conversation; connection, draft or edit approval, quoted text and another conversation are not consent.
- Each assistant's (account and OAuth client) first tool call after a server process starts
  carries `notifications/tools/list_changed` ahead of its result, as does every
  `get_report` refused for a missing intent, so clients holding tool schemas from before
  a release refresh them; the announced set is per process and in memory.
- Each `tools/call` increments a daily counter before running, and a call over the limit
  returns `rate_limited` with a reset time.
- Each call logs the tool, outcome, time, and an error code from a fixed list, never
  text or identity.
- The tool name is read early, so calls refused before dispatch are still logged.

## The four tools

Files: `server/src/mcp.ts`, `server/src/mcp-tools.ts`.

- `get_cover_sheet` returns the cover rules, version, report index, and `is_empty`, plus
  the optional setup script while the whole account has no rules or samples.
- `get_cover_sheet` takes no arguments and refuses any argument it is sent.
- `get_report` returns one report's text, sample list, version and a personal `kinds` index (`{kind_id, kind}`, ascending ID) from every active sample in that report before the eight-sample selection, independent of intent, plus setup while the report has no rules or samples.
- `doc` is accepted as an alias for `document`.
- `list_reports` returns all five reports, with a one-line setup hint instead of the full
  script, only for reports with no rules or samples.
- `create_memo` saves rules, edits, moves and sample changes together or not at all; context correction cannot combine with sample insertion or retirement.
- Replies add the daily update balance if it can be read within 250 ms.
- Replies also add a trial notice if one is due, and neither extra can fail the call.
- Failures return a code and message, and unknown failures say no save outcome is
  confirmed.

## Reads

Files: `server/src/store/compiled.ts`, `server/src/store/snapshot.ts`,
`server/src/store/cards.ts`.

- A read takes no lock and writes nothing: one statement loads the latest card versions,
  the active samples and whether the account is active, so a save shows whole or not at
  all.
- Assistant reads are blocked once an account reads as expired, but the person's own web
  view is not.
- An assistant read is two queries (that statement and the trial gate) and opens no
  database connection; the web view's is one.

## Assembling documents

Files: `server/src/store/reports.ts`, `server/src/store/compiled.ts`.

- Reports are fixed in code: email, chat, post, document, and speech.
- Cards print as bullets in insertion order, and an older stored `- ` is not doubled.
- A report is its heading, "Applies when…", selected samples as quotes, and then rules.
- `get_report` requires intent (situation, optional personal `kind_id` and context dimensions); invalid or foreign kinds are refused without creating one.
- One snapshot computes full-text rank; deterministic selection prefers requested kind, purpose overlap count, exact dimension match count, situation rank over summary/body, newest, then ascending ID, filling up to eight with broader examples and reporting exact match signals.
- Unknown scope stays unknown; excerpts do not establish whole-work structure, and report text, app and complete export show approved summary and dimensions.
- Without intent (`list_reports`, the web page), a report serves its newest eight.
- The cover sheet prints a note explaining `Baseline:` whenever any active rule has that
  prefix.
- `TPS.md` is the cover sheet plus every non-empty report, with all its active approved
  samples in newest-first order (then descending id on a timestamp tie);
  retired samples and superseded revisions stay excluded.
- `is_empty` means no rules and no samples anywhere.
- The approved-source version is a fingerprint of the rules and samples: a hash of the user, the cover
  sheet, and each report's text (newest eight) with every active sample's ID, kind and sample revision, so
  it is the same for every intent. The same cards and samples
  always give the same version; derived guide text, status and enrollment do not affect it.
- A client holding a version from before fingerprints (a revision hash) conflicts once
  on its next save, rereads, and saves on the new version.

## Saves

Files: `server/src/store/compiled.ts`, `server/src/store/save.ts`,
`server/src/store/snapshot.ts`, `server/src/store/accounts.ts`,
`server/src/store/provenance.ts`, `server/src/exact-edits.ts`.

A save runs in one transaction under the account lock: replay or gates, then
validation, the writes, publishing and the receipt, which commits with its result or
not at all.

### Admit

- The input schema is strict: 1 to 100 rules, up to 500 edits, moves, or sample removals, a
  UUID request ID, and a version.
- Only assistants can save, so a save through the web app's store is refused with
  `assistant_required`.
- Input is hashed, and the same request ID with the same input replays the original
  result.
- The same request ID with different input is refused.
- A concurrent save of the same request waits on the account lock, then replays.
- A stale `expected_version` returns `conflict` with the current version.
- A request with no rules, edits, moves, or sample changes is refused, but only after
  replay, so an older receipt still recovers.
- Oversized input fails, and that decision is stored on the receipt so it replays.
- Trial and daily-limit refusals write no receipt, so the same request can succeed later.
- If the commit's acknowledgment is lost, Milton looks up the receipt under the account
  lock: present, it returns the stored outcome; absent, nothing was written and the
  store error stands. Only when that lookup fails too does it return
  `save_outcome_unknown`.

### Validate

- An edit's `before` must occur exactly once across rules as printed, and within one rule.
- All edits resolve against the same original snapshot, and overlaps are refused.
- Emptying a rule through an edit retires it.
- Moves quote a rule once, each rule moves once per save, and a removed rule cannot move.
- A change cannot leave two identical rules in one report.
- New rules already on file are skipped silently.
- A rule starting `Baseline: ` must match the setup catalog exactly for that report.
- The error for a bad baseline names the closest catalog rule, found by shared words.
- Rule text cannot contain Markdown headings, because Milton prints those.
- Each rule and each assembled report has a size cap.

### Apply

- Validation and writes run after a savepoint; a refusal or failure rolls back to it,
  so nothing changes and the receipt stores the failure.
- Rule changes append new versions, so nothing is overwritten.
- An edit plus a move on the same rule produces one version.
- Moving a rule to the report it is already in changes nothing.
- A new rule's description is its first non-blank line, cut to its byte cap, and
  descriptions are never printed.
- Omitting a rule never removes it, and a no-op save returns `unchanged`.
- A new example identical in body, report/kind and complete context files nothing; different context can justify a separate identity, and revisions never merge identities.
- Kinds match by label, ignoring case.
- A `kind_id` must name a kind in the same report.
- Each sample requires context `version: 1` and a useful one-line summary; optional purposes, medium, audience, interaction, whole/excerpt scope, language and register use fixed keys and bounded open vocabulary, leaving unknowns absent.
- `sample_context` appends a complete approved revision, preserving body and stable ID and optionally reclassifying within the report; omitted optional context fields clear.
- Every changed sample snapshot advances its revision and fences all saves even outside the served eight; identical revisions append nothing, and request retries replay deterministically.
- `sample.sample_id` revises an active identity with complete approved body, context and report/kind; omission creates an identity plus revision one, and `replaces` is no longer accepted.
- Approval date and all sample recency ordering use latest revision time, including metadata changes; original creation time and actor remain on the stable identity.
- Each sample removal must name an active sample, listed once.
- Every approved sample stays until explicit `retire_samples` appends an inactive complete snapshot; `samples_retired` reports retired stable IDs, while reads/app/exports show only latest active revisions with stable ID and revision metadata.

### Publish

- Publishing checks the assembled documents against their size limits and answers with
  their new approved-source fingerprint; sample changes durably invalidate guides in the same transaction.
- An audit row records the request, assistant, before and after versions, and affected
  cards.
- The receipt is written last, once, with the outcome.

## First setup

Files: `server/src/store/setup.ts`.

- Setup invites pasted-writing cleanup by default; explicit requests to add or import examples go directly to that conversation, with examples optional. Reads assemble text without saving.
- Setup is offered once when `get_cover_sheet.is_empty` says the whole account is empty; a declined offer is not repeated.
- A report carries optional help only while it has no rules or samples; other empty reports run setup only on request.
- Existing rules and samples are preserved; sample-only and rules-only guidance are usable.
- Candidate lookup requires the person's request and already authorized access; pasted examples also work.
- The shared setup prompt connects and reads existing guidance, then invites a scoped edit with a separate change list; both edited text and older examples are displayed as placeholder-safe proposals before exact retention approval. Candidate lookup needs the person's request and existing authorized access; automated, forwarded and third-party text is excluded even on populated accounts.
- Automated, forwarded and third-party text are excluded; a sent item is not assumed to represent the person's voice.
- Proposed samples replace private details with placeholders before exact retention approval; excerpts are explicit and approved text is never silently changed.
- Every sample save shows exact text and proposed useful non-private context for one retention approval; unchanged approved metadata needs no second approval, and the save uses an existing or concise new personal kind, version fence, idempotency and readback.
- Setup consent authorizes conversation, not inbox access, account changes, transcript import or saving unseen text.
- Setup verifies a successful read before the cleanup task and helps without requiring samples or rules; optional whole-account examples and the next task use emails or DMs, filed under email or chat. Other report scripts keep optional examples and tasks matching their report; skipping examples never blocks writing or makes a voice claim.
- Draft or edit approval, approval to send or praise is not retention approval; one yes covers the displayed text and context, and changed text or context, including redaction, requires renewed approval.
- The sample approval step includes the approved-edit one-time offer and excludes the change list; another writing task is requested only if the person wants one.
- Rules remain available on request; a sample never implies a standing rule or turns its facts into preferences.
- The historical `setupCatalog` remains canonical for Baseline validation; setup no longer generates Baseline rules, and a rejected Baseline points to the closest rule and report in the same error.
- A standing instruction is offered separately and changed only with separate consent; a successful read verifies the connection, not future compliance.

## Sign-in and accounts

Files: `server/src/auth.tsx`, `server/src/auth-session.tsx`, `server/src/auth-login.tsx`,
`server/src/auth-assistants.tsx`, `server/src/auth-account.tsx`, `server/src/pages.tsx`,
`server/src/billing.tsx`, `server/src/store/index.ts`, `server/src/store/billing.ts`,
`server/scripts/backfill-subscriptions.ts`.

- Native auth hosts verified password/email, Google/GitHub, consent and account security; own form destinations and direct native URL-encoded browser form POST redirects (including logout confirmation) share an escaped fresh-document Continue navigation under strict same-origin form policy; direct GET, JSON/fetch and machine calls retain native redirects, and finalized native/static/refusal responses use strict-origin referrers (origin only, no paths/queries/proofs, suppressed on HTTPS downgrade) so same-origin form POSTs retain Origin while missing/null/foreign Origins stay refused; responses retain their security headers and native cookies; app never handles passwords or native cookies.
- App uses maintained code/S256 OIDC with shared SQL one-use state/nonce/verifier, exact callback, signature/issuer/audience/subject and matching UserInfo/opaque-token proof.
- Identity-only app sessions last at most one absolute hour and never outlive their native opaque token; renewal starts a new SSO flow with no refresh/offline scope.
- App cookies are host-only Secure/HttpOnly/SameSite=Lax over HTTPS; every use checks the original nonempty sid, immutable binding, incarnation and generation against native SQL.
- Invalid proof refuses; actual native5xx/network/timeout is 503; an uncertain spent callback recovers through a new login.
- New logins reclaim at most16 expired flows/sessions each; admission correlations expire after24 hours with bounded reclaim, while eligibility/key policy/legacy mapping and original operation associations remain indefinitely for their stated purposes.
- Forms require same origin, an ASCII CSRF token and unique fields; sign-in rotates CSRF.
- Auth runtime and owner command pools always verify PostgreSQL TLS certificates/hostnames, even with mode omitted; unsafe/libpq/duplicate URL settings refuse.
- Every native generation advance or deletion atomically retires older reset proofs; issuance takes the original user snapshot under the same parent lock, never the redemption-time generation.
- Native unlink awaits app eligibility preservation before taking its parent lock; app uses guarded original metadata and stores fingerprints for existing writing accounts only, without billing or admission.
- Native mail callbacks capture one original message; every generic signup/reset/resend success commits the same encrypted-job or no-op receipt outside native swallowing, with no provider I/O during HTTP; failure is uncertain/retryable503.
- Auth-only mail functions lease one original message at a time for bounded delivery, stable job-id idempotency, finite retries and shared Retry-After pause capped at24 hours by worker and SQL across passes; native authority never rebinds to a later email owner.
- Native capture checks its one-hour lifetime on the native clock; SQL accepts only finite future proof expiry and caps mail delivery at native expiry or15 minutes; terminal transitions clear payloads and bounded owner maintenance clears expired/fenced payloads and receipts eligible after24 hours, with physical retention longer if maintenance is delayed.
- Bootstrap000 validates an explicit complete retained-login CONNECT/audited TEMP inventory before transactional pregrants/PUBLIC revocation; missing or inconsistent inventory refuses without partial privilege loss.
- Authenticated native admission carries exact issuer/subject/continuation and native-validated verified email and bounded Google/GitHub IDs, including [] for password-only.
- App admission checks the dedicated eligibility-key policy, then creates/finds one stable internal m_* account and trial and applies existing subscription admission; untrusted/invalid handoffs cause no mapping or billing effects.
- Ownership uses exact issuer+subject, never email, provider nickname or eligibility fingerprints; native linking never merges writing or restarts a trial.
- Account creation's unique identity row and billing's row lock converge under retries/concurrency; a new account starts empty.
- Email and stable social identities get keyed trial-eligibility fingerprints with a dedicated stable key and first claimant, retained after deletion; changed/unprovisioned keys refuse admission.
- Owner-only verified metadata import/dry-run preserves internal IDs, writing, trial/billing history and old neon:subject deletion markers; ambiguous mappings refuse and managed rows remain intact.
- A trial row with no status gets the existing 30-day Stripe trial when billing is configured; no row/status or billing disabled calls no Stripe API.
- Subscription creation locks the trial row across customer/list/create; minute-based idempotency retains the known remote-success/local-timeout ambiguity across a minute boundary.
- Billing failures stop admission with retryable503; existing Stripe state is listed/reconciled before another create.
- The subscription backfill remains an owner-selected dry run by default and never gives returning deleted identities another trial.
- Account security routes to native UI; destructive deletion requires authoritative native freshness, exact typed confirmation and retention of current guarded verified-identity fingerprints.
- App persists lifecycle UUID, original account/subject/incarnation/client and requester association before first native/remote attempt; retries never select current/recreated targets.
- Disconnect commits native original-binding refusal before bounded cleanup; reconnect creates a new binding and never revives an old token.
- Deletion commits refusal, then Stripe cancellation, then writing erasure, and finally bounded native cleanup; unknown inventory/cascade shape leaves a retryable incomplete operation.
- Writing and original-incarnation app credentials are never erased before Stripe cancellation succeeds; incomplete deletion never claims completion.
- Browser logout removes local authority and navigates through fixed-client native RP logout with exact return and native confirmation, leaving offline assistant grants independent.

## Web app

Files: `server/src/pages.tsx`, `server/src/memo-pages.tsx`, `server/src/auth.tsx`,
`server/src/auth-session.tsx`, `server/src/auth-assistants.tsx`.

- Pages run no scripts, under a strict CSP, and are not cached.
- A page route that fails shows "Unable to continue" at the error's status, with a link back
  where one applies.
- An unknown error there reads as a 503 and is logged.
- The home page shows a marketing page signed out and the cover sheet signed in.
- `/tps-report` shows the same cover sheet as the signed-in home page.
- The cover sheet renders as a TPS form filed by Milton, with counted section links,
  report counts and subheadings, exact sample descriptions above wrapping metadata,
  native sample disclosures, rules, and a random joke comment.
- Both empty-app setup paragraphs lead with pasted-writing cleanup and optional older examples beside the shared prompt; populated accounts point to the next email or DM.
- Empty reports remain optional later uses; sample-only reports never show an unfinished setup state.
- If the structured read fails, it falls back to plain report text.
- `/download` returns the complete writing export as `TPS.md`; the web report labels
  its sample count as shown, explains its newest-eight-per-report limit and links to
  the complete download, including when assistant access is paused.
- `/assistants` lists bounded live native connections grouped by client and read/write access, and original incomplete disconnects; a full native page explicitly reports incomplete listing.
- The setup prompt changes depending on whether the account is empty.
- Account opens a native popover; Escape closes it and returns focus to Account, and
  clicking outside closes it.
- With billing configured, the account menu on every signed-in page offers Add a card in a
  trial, Subscribe when expired, and Manage billing when paid; early access shows nothing.
- If the status read fails, the page still renders, with no billing item.
- A note above the report shows only in a trial's last 7 days or when expired, with the same
  button; it shows nothing when paid or earlier in a trial.
- Without billing configured there are no buttons.

## Limits and trials

Files: `server/src/store/index.ts`, `server/src/store/trials.ts`,
`server/src/store/billing.ts`, `server/src/billing.tsx`, `server/src/config.ts`.

- Limits live in a single `store_config` row and are validated on read.
- Each account gets 10,000 attempted MCP calls per UTC day; rule and sample text is capped
  at 128 KiB, and a save takes up to 100 rules and 500 edits, moves, or sample removals
  (0032).
- Trials are switched by `trials_enabled`, and when off, everyone is early access.
- With trials on, access follows the Stripe subscription status held on the trial row:
  trialing reads as trial, active as paid, and past_due as paid for 3 days from the renewal.
- Past that grace, canceled, unpaid, incomplete, incomplete_expired, and paused read as
  expired.
- No row, no status, or a status Milton does not know reads as early access, so a Stripe
  outage never cuts off a connected assistant, and reads never call Stripe.
- A trial notice is claimed once per stage, 7 days and 1 day before `trial_end`, only
  while trialing, and carries the one link, the signed-in app home.
- Expired accounts are blocked for assistants with a refusal carrying that link, while the
  web view and download stay open.
- The three Stripe settings are all or nothing: any one set means all three must be valid,
  or the app fails at startup.
- With billing unset, both billing routes and a POST to the webhook answer 503.
- Every Stripe call uses a pinned API version and a 5-second timeout, through Milton's own
  fetch client rather than the Stripe SDK, which keys and retries POSTs on its own.
- Only the app service routes `/billing/webhook`, ahead of the browser pages, so no session,
  cookie, or CSRF check reaches it.
- The webhook takes only POST with a JSON body, and a signature more than 5 minutes old
  fails.
- The Stripe webhook verifies the signature with the official `stripe` package, then takes
  only a customer ID from the six handled event types, because Stripe does not guarantee
  event order.
- A handled event Milton cannot parse gets a 400 unrecorded, so Stripe retries it.
- For a customer Milton holds, the webhook locks the row, reads the customer's
  subscriptions from Stripe, and writes the deciding one where it records the event.
- The deciding subscription is active, then trialing, then past_due, otherwise the newest.
- Only a successful empty list with a stored subscription writes canceled.
- Any non-2xx from Stripe's list, 404 included, is a failed read: the webhook answers 503
  unrecorded so Stripe retries, and sign-in stops with try again.
- A replayed event, an unknown type, or a customer Milton does not hold calls nothing.
- Both billing routes take only signed-in POST forms with the CSRF check.
- `/billing/checkout` answers 409 to an account with no trial row.
- `/billing/checkout` sends trialing, active, past_due, unpaid, and paused to the Stripe
  portal.
- With a stored customer, it lists Stripe first and goes to the portal if any such
  subscription exists, storing it, so a late webhook cannot sell a second subscription.
- An account still waiting on its trial takes it first, then the portal, or a 503 if it did
  not start, so paying early cannot lose the 30 days.
- Any other status gets Checkout in subscription mode, card required, no trial.
- `/billing/portal` sends an account with a stored customer to the Stripe portal, and
  answers 409 without one.
- Before opening Stripe, both routes copy the sign-in email to a stored customer, so a
  backfilled customer gets one before it can add a card; a failed copy is logged and never
  stops anyone paying.
- Both routes leave through a page that navigates, because `form-action 'self'` blocks an
  external redirect after a form.
- A Stripe session URL is used only if it starts with Stripe's checkout or portal host.

## Database guarantees

Files: `server/drizzle/`, `server/src/store/schema.ts`, `server/src/store/database.ts`.

- Card versions must be sequential, and they cannot be changed or deleted while the card
  exists.
- Kind identities, sample identities and complete revisions are immutable; database guards serialize sequential appends on the account lock, refuse changes to inactive samples, enforce tenant/classification references and cascade account hard deletion.
- Forward migration `0002_sample_versions` maps linear replacement chains to root IDs, retains known snapshots and legacy provenance, keeps retired/consolidated leaves inactive, and leaves accepted-change evidence intact; unavailable context history is not invented.
- Migration refuses cycles, branches and invalid tenant/report/lifecycle parents before destructive changes; this breaking schema/API upgrade requires an authorized closed-ingress cutover with compatible app/MCP code.
- A receipt is written once with its outcome and cannot change.
- Audit rows are immutable and must reference real card versions.
- History has no size cap. History rows never shrink short of account deletion, so the
  lifetime cap that refused every save once an account reached it is gone (0030), with
  the `retained_bytes` counter it read.
- User IDs cannot change.
- Disconnects and identity hashes have no foreign key to users, so they outlive the account.
- `connection_keys` (0004) cascades from users, checks id, hash, name, scope and dates, and grants nothing to the legacy writing group; owner file `006-connection-keys-roles.sql` lets app read every column but the hash, insert and set `revoked_at`, and MCP read and set `last_used_at` only.
- `stripe_events` keeps each event's ID, type, and body hash, never the payload.
- The database holds cards and their immutable versions; the obsolete memo tables and
  the unused card-version `legacy` flag are removed by the cleanup.
- Fresh installs use one Drizzle baseline; the exact 0033 journal has an atomic owner-only
  transition that preserves current data and marks that baseline applied. Other old states refuse.
- Distinct app/MCP roles have explicit writing grants, no inherited owner/group/DDL/TEMP privileges and no native secret reads; app-only session/flow/lifecycle/eligibility storage is denied to MCP/auth.
- The runtime role can read and lock the `store_config` row but cannot change its settings.
- PostgreSQL connection, query, transaction-control and close failures become store errors: known triggers and constraints get clean coded responses, unknown failures log only class/code, and callback errors survive rollback/close unchanged.
- The store opens only a database named `milton`, over TLS.
- Runtime queries use bounded direct PostgreSQL TLS connections; transactions keep one connection with lock and statement timeouts.

## Static site

Files: `apps/site/`.

- Astro builds static pages and copies shared fonts from the theme.
- Every static page, including 404, shows the same shared footer navigation.
- `/for-agents` serves a static product briefing, alternatives, tools, approval rules, export, price, evidence limits and an optional first writing task in the initial HTML.
- The hero demo shows one fictional cleanup request with illustrative plain-AI and
  Milton outputs; build-time ordered word matching computes words kept from the
  displayed strings, ignoring case and punctuation except normalized internal
  apostrophes, and unmatched output words stay underlined. One 10,500 ms clock sweeps
  a paper tint over edits with two 2,150 ms reading holds; all text and scores remain
  readable throughout, with no playback controls or status announcements.
- Playback waits for 35% card visibility, or 80% of the maximum visible card area when a
  short viewport cannot show 35%; resizing updates that threshold, and playback pauses
  off-screen or in a hidden tab, preserving its position.
- Reduced motion or disabled JavaScript shows the complete illustration without animation.
- The setup widget copies a prompt, falls back to manual selection, and closes on Escape
  or an outside click.
- The fake crowdfunding campaign on `/pricing` is static data.
- `/research` presents the approved testing notes, linked from About and the site footer.
  `/notes` is retired with no redirect or alias, so old URLs reach the normal 404.
- Every page loads Vercel Analytics.

## Theme, scripts, and CI

Files: `packages/theme/`, `server/scripts/`, `.github/workflows/checks.yml`.

- A shared theme supplies fonts, favicons, and tokens, with a WCAG contrast test.
- `migrate.ts` applies writing migrations only as neondb_owner; explicit --app-auth applies app-only migration005 after native004 as an approved app migration owner, with no runtime startup migration.
- It takes the owner connection from `MILTON_OWNER_DATABASE_URL` for a release, otherwise
  from `server/.dev.vars`, and never from an inherited `DATABASE_URL`.
- `check-mcp` confirms the instructions, exactly four tools, and a read, without saving.
- `check-local` is an explicitly invoked interactive configured-issuer check; the isolated check-auth-integration builds actual product modules under Node26/PG18 and mocks only external boundaries.
- `check-runtime-role` audits selected NOINHERIT app/MCP roles, ownership, DDL/TEMP and native/app credential/function boundaries.
- `probe-forms` confirms a signed-out form post passes CSRF.
- `build.ts` builds the CSS with Vite and bundles the Cloud Run entry with Bun.
- `dev.ts` serves the app on loopback and rebuilds the CSS on change.
- CI runs types, tests, and formatting, holds no secrets, and does not deploy.

## Optional report guides

Files: `server/src/guides/`, `server/src/guide-worker.ts`, `server/scripts/guide-enrollment.ts`, `server/drizzle/0003_report_guides.sql`.

- Operator-only enrollment defaults off and records explicit processing consent plus an epoch that advances on every off/on transition; app/MCP have no enrollment or consent write privilege.
- Guide eligibility requires enrollment, an active account and an active subscription or an unexpired trial; missing/unknown billing is ineligible.
- A sample-revision trigger advances report source versions and marks durable work in the sample transaction, including while disabled; classification moves invalidate both reports; rules and unchanged saves do not.
- Zero active samples immediately clears the guide and fences old work; nonempty changes retain the last successful stale guide with source/current versions and a reason.
- A finite sequential worker claims at most five reports per run with a 150-second lease, checks eligibility before provider processing/spend/activation and permits two attempts per source/epoch.
- All active originals and complete approved classification/context go in one generation; rules, prior guides and retired revisions are excluded; input is never sampled, truncated or batched.
- Versioned prompting treats samples as untrusted evidence; the fixed Anthropic Opus 5.5 adapter runs at low effort (thinking cannot be disabled; thinking blocks are ignored, never shown or stored), no tools, standard_only generation (omitted from token counting) and a 90-second combined provider deadline.
- Fully serialized input has a conservative 180,000-byte preflight limit and must fit 200,000 provider-counted input tokens; output is limited to 16,000 tokens including thinking, eight evidence-linked tendencies and 6,000 rendered characters.
- Each generation reserves the full 200,000 input + 16,000 output tokens at $4/M input and $20/M output; the singleton lock applies conservative $20/month, $5/day global and $2/day account UTC admission bounds, while unknown outcomes retain reservations.
- Content-free spend entries outlive account deletion; recognized usage settles exactly once upward or downward under the same budget lock, even after output failure, without allowing deletion/churn to reset admission bounds; usage-derived costs are not invoiced costs or guarantees over unrelated usage/provider billing anomalies.
- Completion locks the report row enrollment also updates before evaluating its source/epoch/lease fence in a fresh statement; valid insufficient evidence clears old text and retains its reason on exact-source reuse, while invalid/unfinished/refused output fails without a paid repair loop.
- Expired claims recover within the attempt bound; oversize, budget-limited and exhausted work has terminal status rather than indefinite preparation.
- Both MCP report envelopes carry the same optional self-contained derived guide block with status, freshness and precedence; off/ineligible responses keep their prior shape and the four tool inputs stay unchanged.
- The report page shows read-only tendencies/applicability and plain queued/updating/unavailable reasons only while eligible, retaining the stale explanation; source versions remain in MCP metadata, evidence references validate without entering displayed text, and requested edit scope/explicit rules retain precedence.
- Approved-source limits, expected_version and exports exclude derived guides and status; saves and reads never call a model.
- Account deletion cascades guides/enrollment/work; late completion never creates an account or guide row; disabled completed results are reusable only for the exact current source.
- The guide worker uses the runtimes' direct TLS adapter, a distinct login holding only the guide capability, a provider-only secret payload and no identity, credential, signing-key or session access; app/MCP only read guide state and auth receives no guide capability.
