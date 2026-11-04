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
- Startup fails on bad URLs, a short cookie secret, a bad support email, a bad port, or an
  unknown service name.
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
- Each call logs the tool, outcome, time, and an error code from a fixed list, never
  text or identity.
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
- A report is its heading, "Applies when…", the newest two samples of each kind, newest
  first, as quotes, and then rules.
- The cover sheet prints a note explaining `Baseline:` whenever any active rule has that
  prefix.
- `TPS.md` is the cover sheet plus every non-empty report.
- `is_empty` means no rules and no samples anywhere.
- The version is a fingerprint of what is served: a hash of the user, the cover sheet,
  and each report's text with its samples' IDs and kinds. The same cards and samples
  always give the same version, and nothing assembled is stored.
- A client holding a version from before fingerprints (a revision hash) conflicts once
  on its next save, rereads, and saves on the new version.

## Saves

Files: `server/src/store/compiled.ts`, `server/src/store/save.ts`,
`server/src/store/save-apply.ts`, `server/src/store/save-publish.ts`,
`server/src/store/provenance.ts`, `server/src/exact-edits.ts`.

A save runs in one transaction under the account lock: replay or gates, then
validation, the writes, publishing and the receipt, which commits with its result or
not at all.

### Admit

- The input schema is strict: 1 to 25 rules, up to 100 edits, moves, or sample removals, a
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
- Identical sample text for a kind files nothing.
- Kinds match by label, ignoring case.
- A `kind_id` must name a kind in the same report.
- Replacing a sample requires an active sample of the same kind.
- Each sample removal must name an active sample, listed once.
- Every approved sample stays until the person replaces or removes it; reports serve the
  newest two per kind. `samples_retired` reports what `replaces` and `retire_samples`
  retired.

### Publish

- Publishing checks the assembled documents against their size limits and answers with
  their new fingerprint; it stores nothing beyond the cards and samples.
- An audit row records the request, assistant, before and after versions, and affected
  cards.
- The receipt is written last, once, with the outcome.

## First setup

Files: `server/src/store/setup.ts`.

- Setup is a served script of questions, stored as data, and Milton only assembles it.
- The first-setup opening appears only while no rules exist anywhere, and any later block
  opens by saying it runs only on request.
- A report's block is served while that report has no rules.
- `get_cover_sheet` serves email's block while no rules exist anywhere.
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
`server/src/auth-assistants.tsx`, `server/src/auth-account.tsx`, `server/src/pages.tsx`,
`server/src/billing.tsx`, `server/src/store/index.ts`, `server/src/store/billing.ts`,
`server/scripts/backfill-subscriptions.ts`.

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
- One identity has one account: two first sign-ins at once both reach it, because the
  one that loses the identity insert drops its own new account and uses the winner's.
- A new account starts empty, with a trial row if trials are on.
- With billing configured, a trial row with no status gets a Stripe customer and a 30-day
  Stripe trial with no card, which cancels at the end if no card was added.
- No new approval lands until then: `/login`, the consent page, and an Allow on the consent
  form each ensure it first, and denying needs nothing.
- An approval Neon already holds skips those pages and refreshes without Milton, so existing
  accounts depend on the backfill.
- A Stripe failure stops that step with a 503 saying to try again, and charges nothing;
  repeating the sign-in is the retry.
- On a plain web sign-in, with no assistant involved, that page also links to Milton home.
- With billing unset, no row, or a status already set, no step calls Stripe.
- The row stays locked across customer, list, and create, so a concurrent attempt finds the
  result rather than making a second customer or trial.
- What Stripe already has is listed first, so a retry stores it rather than starting again.
- `server/scripts/backfill-subscriptions.ts` does the same for every active account, paced
  at about 5 a second: a dry run unless told otherwise, it skips rows with a status, sends
  no email, prints only counts, and refuses without `trials_enabled` and a live key.
- The backfill cancels a returning deleted identity left with no status, by 0027's rule,
  and counts it as skipped, so it never gets a trial.
- A reply lost after Stripe made a customer can leave an orphan: never charged, may hold an
  email, removed by hand in Stripe if ever needed.
- Idempotency keys carry the UTC minute, because Stripe replays a stored error for a day.
- A returning deleted identity gets a row already marked canceled, trials on or off, found
  through its hash, so it gets no Stripe trial and reads as expired while trials are on.
- Disconnecting writes Milton's refusal first, then removes the consent at Neon.
- If the Neon removal fails, the page offers Retry while the refusal stands.
- Approving an assistant again clears its refusal, retrying once.
- Signing out ends the session at Neon and clears Milton's cookies, and it never
  disconnects assistants.
- Switch account signs out and lands on `/login`.
- Deletion requires the exact phrase "delete my account" and a live consent list.
- Deletion first deletes any Stripe customer, ending its subscription at once with no
  refund; after any failed delete, only a read that reports the customer deleted counts as
  done, and any other result deletes nothing.
- The row then clears the customer and subscription and reads canceled, so if Milton's own
  delete fails, a retry calls nothing and a later Checkout makes a new customer.
- Deletion records disconnects and the identity hash, then deletes the user and cascades.
- Consent removal and sign-out after deletion are best effort.

## Web app

Files: `server/src/pages.tsx`, `server/src/memo-pages.tsx`, `server/src/auth.tsx`,
`server/src/auth-session.tsx`, `server/src/auth-assistants.tsx`.

- Pages run no scripts, under a strict CSP, and are not cached.
- A page route that fails shows "Unable to continue" at the error's status, with a link back
  where one applies.
- An unknown error there reads as a 503 and is logged.
- The home page shows a marketing page signed out and the cover sheet signed in.
- `/tps-report` shows the same cover sheet as the signed-in home page.
- The cover sheet renders as a TPS form with counts, rules, samples, and a random joke
  comment.
- It shows setup prompts for reports without rules.
- If the structured read fails, it falls back to plain report text.
- `/download` returns the report as `TPS.md`.
- `/assistants` lists live consents and looks up at most 20 names per view.
- The setup prompt changes depending on whether the account is empty.
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
- Samples and kinds are append-only, and a sample can only be retired.
- A receipt is written once with its outcome and cannot change.
- Audit rows are immutable and must reference real card versions.
- History has no size cap. History rows never shrink short of account deletion, so the
  lifetime cap that refused every save once an account reached it is gone (0030), with
  the `retained_bytes` counter it read.
- User IDs cannot change.
- Disconnects and identity hashes have no foreign key to users, so they outlive the account.
- `stripe_events` keeps each event's ID, type, and body hash, never the payload.
- The older `memos`, `memo_versions`, and `memo_cards` tables remain, and no server code
  reads or writes them.
- The runtime role has least privilege, owns nothing, and can delete only from `users` and
  `assistant_disconnects`.
- The runtime role can read and lock the `store_config` row but cannot change its settings.
- Known trigger errors become clean coded responses.
- The store opens only a database named `milton`, over TLS.
- Reads use HTTP queries, and transactions use one WebSocket client each, with lock and
  statement timeouts.

## Static site

Files: `apps/site/`.

- Astro builds static pages and copies shared fonts from the theme.
- The hero demo types out a scripted conversation.
- The demo pauses off-screen or in a hidden tab, and respects reduced motion.
- The setup widget copies a prompt, falls back to manual selection, and closes on Escape
  or an outside click.
- The fake crowdfunding campaign on `/pricing` is static data.
- Every page loads Vercel Analytics.

## Theme, scripts, and CI

Files: `packages/theme/`, `server/scripts/`, `.github/workflows/checks.yml`.

- A shared theme supplies fonts, favicons, and tokens, with a WCAG contrast test.
- `migrate.ts` runs only against the `milton` database as `neondb_owner`.
- It takes the owner connection from `MILTON_OWNER_DATABASE_URL` for a release, otherwise
  from `server/.dev.vars`, and never from an inherited `DATABASE_URL`.
- `check-mcp` confirms the instructions, exactly four tools, and a read, without saving.
- `check-local` runs the same check through a real OAuth sign-in against a running server,
  keeping credentials in memory.
- `check-runtime-role` confirms a connection has no elevated rights.
- `probe-forms` confirms a signed-out form post passes CSRF.
- `build.ts` builds the CSS with Vite and bundles the Cloud Run entry with Bun.
- `dev.ts` serves the app on loopback and rebuilds the CSS on change.
- CI runs types, tests, and formatting, holds no secrets, and does not deploy.
