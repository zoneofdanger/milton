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
- Google's load balancer sends `app.meetmilton.com` to the app and everything else to MCP.
- HTTP upgrades to HTTPS with a redirect that keeps the method.
- Vercel builds the static site from main on every push.
- Startup decrypts a dotenvx file using a separate platform-held key.
- Startup fails on a retired inline secret, bad URLs, a short cookie secret, a bad support
  email, or a bad port.
- Plain HTTP is allowed only on loopback outside production.
- On SIGTERM the server stops accepting requests and force-exits after 8 seconds.
- The image builds with Bun, then ships only the bundle and public assets to a non-root
  Node container.

## Every HTTP request

Files: `server/src/index.ts`, `server/src/cloud-app.ts`, `server/src/http.ts`,
`server/src/assets.ts`, `server/src/error-log.ts`.

- A request is refused unless its Host matches that service's canonical host.
- The app rewrites each URL to its configured origin, because TLS ends upstream.
- Bodies over 64 KiB get a 413 before parsing, auth, or database work.
- `/mcp` goes to the MCP handler on the MCP service and returns 404 on the app.
- `GET /health` returns ok.
- `/.well-known/oauth-protected-resource` publishes the resource and its auth issuer.
- Any other path on the MCP host redirects to the app host with a 308.
- Static files are served from a fixed list of six, never arbitrary paths.
- Unexpected errors show browsers a "PC LOAD LETTER" page, and everything else gets a JSON 503.
- Error logs hold only the location, class name, and code, never messages or tokens.

## An MCP call

Files: `server/src/handler.ts`, `server/src/token.ts`, `server/src/mcp.ts`,
`server/src/mcp-outcomes.ts`, `server/src/store/index.ts`.

- Only POST and OPTIONS pass.
- Origin is deliberately not checked, so web clients reach auth from any origin. The Host
  check stops DNS rebinding and tokens authenticate every call, but this departs from the
  MCP spec's rule that servers validate Origin.
- The bearer JWT is checked locally against Neon's public keys, which are cached for 10
  minutes.
- The check covers algorithm, issuer, audience, and required claims, with 30 seconds of
  clock tolerance.
- A bad token gets a 401 that points the client to the sign-in metadata.
- Each request also checks that the account is active and the assistant is not
  disconnected.
- Each request builds a fresh stateless MCP server, with no sessions or subscriptions.
- Each `tools/call` increments a daily counter before running, and a call over the limit
  returns `rate_limited` with a reset time.
- Each call logs the tool, outcome, time, memo-update state, and an error code
  from a fixed list, never text or identity.
- The tool name is read early, so calls refused before dispatch are still logged.

## The four tools

Files: `server/src/store/tools.ts`, `server/src/mcp.ts`.

- `get_cover_sheet` returns the cover rules, version, report index, and `is_empty`, plus
  the setup script while no rules exist.
- `get_cover_sheet` takes no arguments and refuses any argument it is sent.
- `get_report` returns one report's text, sample list, and version, plus setup while that
  report has no rules.
- `doc` is accepted as an alias for `document`.
- `list_reports` returns all five reports, with a one-line setup hint instead of the full
  script.
- `create_memo` saves rules, edits, moves, samples, and sample removals together or not at
  all.
- Replies add the daily update balance if it can be read within 250 ms.
- Replies also add a trial notice if one is due, and neither extra can fail the call.
- Failures return a code and message, and unknown failures say no save outcome is
  confirmed.

## Reads

Files: `server/src/store/compiled.ts`, `server/src/store/cards.ts`.

- A read locks the account row, so it serializes with saves.
- Assistant reads are blocked after a trial expires, but the person's own web view is not.
- Each read loads the latest card versions and active samples, and fingerprints them.
- If the stored report lags that fingerprint, the read rebuilds and republishes it.

## Assembling documents

Files: `server/src/store/reports.ts`, `server/src/store/compiled.ts`.

- Reports are fixed in code: email, chat, post, document, and speech.
- Cards print as bullets in insertion order, and an older stored `- ` is not doubled.
- A report is its heading, "Applies when…", samples newest first as quotes, and then
  rules.
- The cover sheet prints a note explaining `Baseline:` whenever any active rule has that
  prefix.
- `TPS.md` is the cover sheet plus every non-empty report.
- `is_empty` means no rules and no samples anywhere.
- The version is a hash of user and revision, and one current snapshot is kept per user.

## Saves

Files: `server/src/store/compiled.ts`, `server/src/store/save-claim.ts`,
`server/src/store/save-apply.ts`, `server/src/store/save-publish.ts`,
`server/src/store/memo-updates.ts`, `server/src/store/provenance.ts`,
`server/src/exact-edits.ts`.

### Claim

- The input schema is strict: 1 to 25 rules, up to 100 edits, moves, or sample removals, a
  UUID request ID, and a version.
- Only assistants can save, so the web app's store has no save path.
- Input is hashed, and the same request ID with the same input replays the original
  result.
- The same request ID with different input is refused.
- A running request returns `in_progress`, and an expired one returns `request_expired`.
- A stale `expected_version` returns `conflict` with the current version.
- Oversized input fails, and that decision is stored on the receipt so it replays.
- Trial and daily-limit refusals write no receipt, so the same request can succeed later.
- Admission holds a daily memo update and writes a receipt with a 40-second deadline.
- If the claim's outcome is uncertain, Milton checks the receipt or returns
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

- The apply step locks again and rechecks the receipt, trial, fingerprint, and version.
- Rule changes append new versions, so nothing is overwritten.
- An edit plus a move on the same rule produces one version.
- Omitting a rule never removes it, and a no-op save returns `unchanged`.
- Identical sample text for a kind files nothing.
- Kinds match by label, ignoring case.
- Replacing a sample requires an active sample of the same kind.
- Each kind keeps its newest two samples, and evictions are reported in `samples_retired`.

### Publish

- Publishing rebuilds and stores the report, then bumps the revision.
- An audit row records the request, assistant, before and after versions, and affected
  cards.
- The receipt completes, and the hold is charged only if something changed. Otherwise it
  is released.
- On failure, a committed result wins. Otherwise the receipt fails and the hold is
  released.

## First setup

Files: `server/src/store/setup.ts`.

- Setup is a served script of questions, stored as data, and Milton only assembles it.
- The opening lines appear only while no rules exist anywhere.
- A report's block is served while that report has no rules.
- The cover questions attach while the cover has no rules.
- The text is generated per report: paste a sample, confirm habits, pick options, approve
  the list, and save.
- `setupCatalog` lists every baseline rule the script can file, which is how saves check
  them.
- Setup is triggered by missing rules, not missing samples.
- The first block, served while no rules exist anywhere, ends with the standing-line step:
  the assistant offers one line for the person's own standing instructions. It saves
  nothing to Milton and is left out of later blocks.

## Sign-in and accounts

Files: `server/src/auth.tsx`, `server/src/auth-session.tsx`, `server/src/auth-login.tsx`,
`server/src/auth-assistants.tsx`, `server/src/auth-account.tsx`,
`server/src/store/index.ts`.

- Neon Auth handles Google and GitHub sign-in.
- Live sessions are checked with Neon, ignoring the SDK's cached session cookie.
- Forms need the same origin, a 43-character CSRF token, and no repeated fields.
- The CSRF token rotates at sign-in.
- Upstream auth calls time out after 10 seconds.
- OAuth queries must name Milton's resource, a client ID, a signature, and a clean
  redirect.
- A marker cookie stops an assistant from forcing endless re-logins.
- The consent page shows the assistant's name and destination, and flags unverified
  clients.
- External redirects use a safe meta-refresh page, because the CSP's `form-action 'self'`
  blocks them otherwise.
- Every successful sign-in creates or finds its account; sign-ups are always open.
- A new account starts empty, with a trial row if trials are on.
- With billing configured, a trial row with no status gets a Stripe customer and a 30-day
  Stripe trial with no card, which cancels at the end if no card was added.
- No assistant connects until then: `/login`, the consent page, and an Allow on the consent
  form each ensure it first, and denying needs nothing.
- A Stripe failure stops that step with a 503 saying to try again, and charges nothing;
  repeating the sign-in is the retry.
- With billing unset, no row, or a status already set, no step calls Stripe.
- What Stripe already has is listed first, so a retry stores the subscription rather than
  starting a second trial.
- Idempotency keys carry the UTC minute, because Stripe replays a stored error for a day.
- A returning deleted identity gets a row already marked canceled, found through its hash,
  so it reads as expired and gets no Stripe trial.
- Disconnecting writes Milton's refusal first, then removes the consent at Neon.
- If the Neon removal fails, the page offers Retry while the refusal stands.
- Approving an assistant again clears its refusal, retrying once.
- Deletion requires the exact phrase "delete my account" and a live consent list.
- Deletion first deletes any Stripe customer, ending its subscription at once with no
  refund; Stripe's 404 counts as done, and any other failure deletes nothing.
- Deletion records disconnects and the identity hash, then deletes the user and cascades.
- Consent removal and sign-out after deletion are best effort.

## Web app

Files: `server/src/pages.tsx`, `server/src/memo-pages.tsx`,
`server/src/auth-assistants.tsx`.

- Pages run no scripts, under a strict CSP, and are not cached.
- The home page shows a marketing page signed out and the cover sheet signed in.
- The cover sheet renders as a TPS form with counts, rules, samples, and a random joke
  comment.
- It shows daily usage if enabled, and setup prompts for reports without rules.
- If the structured read fails, it falls back to plain report text.
- `/download` returns the report as `TPS.md`.
- `/assistants` lists live consents and looks up at most 20 names per view.
- The setup prompt changes depending on whether the account is empty.
- The trial banner shows only in a Stripe trial's last 7 days or after expiry, and billing
  is plain text with no link yet.

## Limits and trials

Files: `server/src/store/index.ts`, `server/src/store/trials.ts`,
`server/src/store/memo-updates.ts`.

- Limits live in a single `store_config` row and are validated on read.
- Trials are switched by `trials_enabled`, and when off, everyone is early access.
- With trials on, access follows the Stripe subscription status held on the trial row:
  trialing reads as trial, active as paid, and past_due as paid for 3 days from the renewal.
- Past that grace, canceled, unpaid, incomplete, incomplete_expired, and paused read as
  expired.
- No row, no status, or a status Milton does not know reads as early access, so a Stripe
  outage locks nobody out.
- A trial notice is claimed once per stage, 7 days and 1 day before `trial_end`, only
  while trialing.
- Expired accounts are blocked for assistants, while the web view and download stay open.
- The Stripe webhook verifies the signature, then takes only a customer ID from the six
  handled event types, because Stripe does not guarantee event order.
- For a customer Milton holds, the webhook locks the row, reads the customer's
  subscriptions from Stripe, and writes the deciding one where it records the event.
- The deciding subscription is active, then trialing, then past_due, otherwise the newest.
- An empty list or a 404 with a stored subscription writes canceled.
- A failed Stripe read answers 503 unrecorded so Stripe retries; a replayed event, an
  unknown type, or a customer Milton does not hold calls nothing.
- `/billing/checkout` sends trialing, active, and past_due to the Stripe portal.
- An account still waiting on its trial takes it first, then the portal, or a 503 if it did
  not start, so paying early cannot lose the 30 days.
- Any other status gets Checkout in subscription mode, card required, no trial.
- Daily memo updates count charged and held saves, reset at 00:00 UTC, and are enforced
  only when enabled.

## Database guarantees

Files: `server/drizzle/`, `server/src/store/schema.ts`, `server/src/store/database.ts`.

- Card versions must be sequential, and they cannot be changed or deleted while the card
  exists.
- Samples and kinds are append-only, and a sample can only be retired.
- Completed receipts and recorded memo updates cannot change.
- Audit rows are immutable and must reference real card versions.
- `retained_bytes` tracks stored history against a cap.
- History rows never shrink short of account deletion, so that cap is effectively
  lifetime.
- User IDs cannot change.
- The runtime role has least privilege, owns nothing, and can delete only from `users` and
  `assistant_disconnects`.
- Known trigger errors become clean coded responses.
- Reads use HTTP queries, and transactions use one WebSocket client each, with lock and
  statement timeouts.

## Static site

Files: `apps/site/`.

- Astro builds static pages and copies shared fonts from the theme.
- The hero demo types out a scripted conversation.
- The demo pauses off-screen or in a hidden tab, and respects reduced motion.
- The setup widget copies a prompt, falls back to manual selection, and closes on Escape
  or an outside click.
- The joke tiers on `/pricing` are static data.

## Theme, scripts, and CI

Files: `packages/theme/`, `server/scripts/`, `.github/workflows/checks.yml`.

- A shared theme supplies fonts, favicons, and tokens, with a WCAG contrast test.
- `migrate.ts` runs only against the `milton` database as `neondb_owner`.
- `check-mcp` confirms the instructions, exactly four tools, and a read, without saving.
- `check-runtime-role` confirms a connection has no elevated rights.
- `probe-forms` confirms a signed-out form post passes CSRF.
- `memo-updates.ts` sets the daily limit or switches memo updates on and off.
- CI runs types, tests, and formatting, holds no secrets, and does not deploy.
