# Changelog

The minor version (after the dot) is an integer counter that increments by 1 each change: 0.1, 0.2 ... 0.9, 0.10, 0.11, and so on. The major version (before the dot) is NOT auto-incremented — it only advances when the user manually declares a milestone.

## [Unreleased]

### Issue #12 — hold-for-details activates while scrolling

**Plan:** item cards opened the details modal via a 500ms press-and-hold timer
(`startPress`/`cancelPress`, bound to `mousedown`/`touchstart` + `mouseup`/`touchend`/
`touchcancel`/`mouseleave`). A finger held still on a card while the page scrolls under
it (e.g. a scroll gesture that starts on a card) still counts as a "hold," since nothing
cancelled the timer on movement — only on release. Replacing with double-tap/double-click
via the native `click` event fixes this by construction: browsers don't fire `click`
after a drag/scroll gesture, so there's no separate scroll-detection logic needed.

**Files:** `public/index.html` — replace `startPress`/`cancelPress`/`pressTimer` with a
single `handleCardTap(event, id)` tracking the last tap's id/timestamp; card templates
drop five touch/mouse attributes for one `onclick`. New
`test-e2e/card-double-tap.spec.js`.

**Sprint plan (2026-08-16):** multi-issue improvement sprint ahead of the React Native
migration, covering GitHub issues #8, #5, #6, #7, #9, #10 (issue #1 — multi-location
inventory — and #2 — voice integration — deferred to their own sessions). One feature
branch per issue, sequential, each merged to `main` only once its own tests are green.
Pre-sprint safety net: live DB snapshotted to
`/mnt/user/Kieren/Backup/unRAID/butler/inventory-2026-08-17-presprint.db`, and `main`
tagged `pre-sprint-2026-08-17` (pushed).

### Issue #8 — migrations table / schema version tracking

**Plan:** add a minimal, native-SQLite migrations runner (`PRAGMA user_version`, no new
table) in a new `db-migrations.js`, required from `server.js`. `server.js`'s existing
`CREATE TABLE IF NOT EXISTS` block remains the source of truth for the schema on a
*fresh* database (tests, new installs) — on a fresh DB, `user_version` is set straight
to the top of the migrations list with nothing replayed. On an *existing* database
(the live DB, or any DB from before this change), pending migrations from the current
`user_version` onward run once, each wrapped in its own transaction, then the version is
bumped. The `migrations` array starts empty; future ad-hoc `ALTER TABLE ADD COLUMN`
changes become entries in this array instead, each expected to guard itself with
`hasColumn()` before altering (belt-and-braces per CLAUDE.md's "must be idempotent and
safe against an already-populated database" rule — the version gate already prevents
replay in normal operation).

**Files:** new `db-migrations.js` (runner + `hasColumn` + `migrations` array, CommonJS to
match `server.js`); `server.js` lines ~163–214 (capture `isFreshDb` before opening the
DB, call `runMigrations` after the `CREATE TABLE` block); new `test/db-migrations.test.js`
unit-testing the runner directly against a scratch better-sqlite3 database (fresh-DB
path, existing-DB path, idempotency on repeated calls, `hasColumn`).

### Issue #5 — invoice matching improvements + manual-add duplicate detection

New `item-matching.js` (`normaliseName`, `findMatch`) implements the shared hierarchy:
barcode match > exact normalised-name match > user-confirmed (`matchDecision`) > fuzzy
(suggestion only, never auto-applied).

- `POST /api/invoices/commit`: rewritten to use `findMatch` instead of a bare Fuse
  search. Barcode/exact-name matches auto-apply (deterministic, safe); a fuzzy match is
  only used if the client sends an explicit `matchDecision` (an existing item id, or
  `'new'` to force a new item). As each new item is inserted during the commit loop, it's
  pushed into the in-memory `existingItems` array and `fuse.setCollection()` re-indexes,
  so later line items in the same invoice can match items the invoice itself just
  created. Invoice items may now optionally carry a `barcode` field.
- New `GET /api/items/match?name=&barcode=` — read-only lookup used by both the invoice
  staging UI and the manual add-item flow.
- `public/index.html`: invoice staging list now calls `/api/items/match` per parsed line
  item and shows a badge (barcode/exact-name) or a "possible match" dropdown (fuzzy,
  defaults to "add as new") that feeds `matchDecision` into the commit payload. The
  add-item modal now checks for a match on submit (new items only) and, if found, shows
  candidates with their match-confidence level, letting the user reuse an existing item
  (adds the entered quantity via the existing `PATCH /api/items/:id/quantity` endpoint)
  or override and add as new.

**Tests:** `test/item-matching.test.js` (unit), `test/invoices.test.js` (commit
hierarchy + in-memory update), `test/items.test.js` additions (`/api/items/match`),
`test-e2e/duplicate-detection.spec.js` (manual add reuse/override flows).

### Issue #6 — LLM response schema validation

New `llm-schema.js` (`validateLabelResult`, `validateInvoiceItems`) treats LLM JSON output
as untrusted: non-object/malformed responses fall back to safe empty defaults instead of
propagating `undefined`/wrong-typed values; invoice line items missing a name or a valid
non-negative `quantity` are dropped (logged via `console.warn`) rather than reaching the
DB; an invalid `price` defaults to `0` rather than dropping the whole item.

- `POST /api/parse-label-llm`: the route's existing ad-hoc type-checking (container_details
  object-vs-string coercion, name type guard, category/location lowercase matching) is now
  centralised in `validateLabelResult` — same behaviour, one tested place instead of scattered
  inline checks.
- `POST /api/invoices/parse`: previously passed the LLM's `items` array straight to the
  client with no shape checking at all. Now runs through `validateInvoiceItems` first.

**Tests:** `test/llm-schema.test.js` — unit tests covering both validators directly
(malformed/non-object input, wrong types, missing fields, the object-shaped
`container_details` quirk observed from the vision model). No LLM-mocking infrastructure
exists in this repo yet, so the route wiring itself (thin glue around the now-tested
validators) isn't separately black-box tested — `npm test`'s smoke test confirms the
server still boots with the new require wired in, and the pre-existing backend/e2e suite
(74 + 11 tests) passing unchanged confirms no behaviour regression for well-formed input.

### Issue #7 — standardise front-end HTTP error handling

`public/index.html` had ~22 `apiFetch` call sites with inconsistent error handling: some
checked `res.ok` and threw, most didn't; failures were shown via blocking `alert()`,
`console.error`-only, or silently swallowed; several mutation handlers (category/location
add/edit/delete) ran their success code — clearing the input field — even when the
server returned a non-2xx response, because `apiFetch` never threw on failure.

New `apiRequest(url, options)` wraps `apiFetch`: catches network errors, checks `res.ok`,
and on either failure shows a standardised error toast (extracting the server's `error`
message from the JSON body when present) then throws — so callers' post-request code
only runs on success. Pass `{ silent: true }` for the handful of call sites that need
custom status handling (`/api/items/match` lookups that deliberately fall back to "no
match" rather than erroring; the barcode-lookup 404 case, which isn't really an error).
All ~20 non-silent call sites were switched from `apiFetch` to `apiRequest`, dropping
their now-redundant per-site `if (!res.ok) throw` / `catch { alert(...) }` boilerplate.

- `showToast(message, type)`: now supports an `error` variant (red, 4s) alongside the
  existing success variant (green, 2s); `showError(message)` is a shorthand.
- Added `socket.on('connect_error', ...)` — previously silent; now shows a one-shot error
  toast (reset on reconnect) rather than leaving live-update loss unexplained.
- Login's raw `fetch()` call (pre-auth, no token yet) was deliberately left as-is — its
  bespoke `showLogin()` banner is the right UX for a full-page pre-auth state, not a toast.

**Tests:** `test-e2e/error-handling.spec.js` — asserts a failed request (insufficient
quantity on deduct) shows a red error toast and never triggers a native `alert()` dialog,
and that a successful request still shows the existing green success toast.

### Issue #9 — password reset / recovery runbook

No in-app reset flow exists for the shared household login (by design — single shared
credential, not per-user accounts), so recovery was previously a manual "regenerate a
bcrypt hash somehow" fire-drill. Added `scripts/generate-password-hash.js` (prints a
bcrypt hash for a given password using the same `bcryptjs` dependency the app already
uses) and a new "Recovery: forgotten household login password" section in `CLAUDE.md`
with the three steps: run the script, set `AUTH_PASSWORD_HASH` on the container, restart.

**Tests:** `test/generate-password-hash.test.js` — runs the script as a child process,
verifies the printed hash both accepts the correct password and rejects a wrong one
(via `bcrypt.compareSync`), and that omitting the password argument exits non-zero.

### Issue #10 — leftover local Docker image cleanup

The leftover `terrible-butler-test:verify` image (373MB, left over from the auth
conversion's container verification) was already gone by the time this sprint reached
it — no `docker rmi` needed. The permission fix (so a future cleanup attempt isn't
blocked by Claude Code's own tooling) could not be applied automatically: the auto-mode
classifier blocks Claude Code from editing its own Bash permission rules, since
self-granting permissions is exactly the kind of action that control exists to catch.
Handed to the user as a manual step: add a narrowly-scoped `permissions.allow` rule for
`docker rmi`/`docker rm` on the `terrible-butler-test` image/container name to
`.claude/settings.local.json` (not a blanket docker allowance — this host runs many
unrelated live containers).

## Sprint summary (2026-08-16 to 2026-08-17)

Six-issue improvement sprint ahead of the React Native migration: #8 (migrations
tracking), #5 (invoice matching + manual-add dedup), #6 (LLM schema validation), #7
(standardised front-end HTTP error handling), #9 (password recovery runbook), #10
(Docker image cleanup — partially resolved, permission fix left to the user). Issue #1
(multi-location inventory) deliberately deferred to its own session — see the sprint
plan note above. Each issue landed on its own feature branch with its own
plan/tests/review cycle, merged to `main` individually; nothing was batched into one
combined branch. Pre-sprint safety net: live DB snapshot at
`inventory-2026-08-17-presprint.db` and the `pre-sprint-2026-08-17` git tag, both still
in place for rollback if needed.

### Issue #1 — inventory in multiple locations

**Context:** deferred from the 2026-08-16/17 sprint as the one genuinely large,
schema-changing item. Today `items` has a single `location_id` and single `quantity`
column — one item can only ever be in one place. This adds a proper many-to-many
item↔location stock model, with the reorder threshold compared against the total across
all locations, and location-tab filtering showing that location's quantity plus how much
exists elsewhere.

**Clarified with the user up front (2026-08-17):**
- Deduct: show an explicit location picker only when the item actually has stock in more
  than one location; skip it (deduct straight from the one location) otherwise.
- "All Inventory" tab: one card per item with its **total** quantity plus a small "+N
  elsewhere" note when multi-location, not one card per item-location pair. Full
  per-location breakdown lives in the details modal.

**Schema (via the #8 migrations runner, `db-migrations.js`):** new `item_locations`
table (`item_id`, `location_id` nullable — mirrors `items.location_id`'s current
nullability for "unassigned" stock, `quantity`), with a partial unique index for
non-null `(item_id, location_id)` pairs and a second partial unique index enforcing at
most one null-location row per item. Added to the base `CREATE TABLE IF NOT EXISTS`
block (fresh installs/tests) **and** as a migration entry that creates the table +
indexes and backfills one row per existing item from its current `location_id`/`quantity`
(guarded against re-insertion — safe to re-run). `items.location_id`/`items.quantity`
are **not** dropped (avoids risky DDL on the populated live table) but become vestigial
after this change, alongside the existing vestigial `inventory` table — noted in
`CLAUDE.md`'s Database notes.

**Backend (`server.js`):** a shared base query (`items.*` plus a `COALESCE(SUM(...))`
total-quantity subquery and a `json_group_array`/`json_object` per-location breakdown
subquery, aliased so the last-column-wins behaviour overrides the stale raw
`items.quantity`) used by `GET /api/items`, `/search`, `/match`, `/barcode/:barcode`,
and the `getItem` helper — each response gains a `locations: [{location_id,
location_name, quantity}]` array. `GET /api/grocery-list` / `/api/out-of-stock-ignored`
filter on the aggregated total, not the raw column. `PATCH /api/items/:id/quantity` and
`POST /api/items/:id/deduct` now take a `location_id` (upsert-into / decrement-from that
specific `item_locations` row; a single-location item infers it automatically if
omitted). `POST /api/items` splits into an identity insert (`items`) + one
`item_locations` row for the chosen initial location. `POST /api/invoices/commit`
inserts/increments `item_locations` rows per line item's `location_id` instead of
`items.quantity`, still updating the in-memory match set from #5. Deleting a location
reassigns its `item_locations` rows to the null-location bucket, merging into an
existing null-location row if the item already has one (avoids the partial-unique-index
collision).

**Frontend (`public/index.html`):** location-tab filtering and quantity display switch
to the `locations` array; item cards show total (+ "elsewhere" note) outside a location
tab, or that location's specific quantity inside one. Quick +/- buttons act directly
when the item has one location; for multi-location items they open the existing qty
modal (extended with a location `<select>`) instead of guessing which location to
adjust — same "explicit picker when ambiguous" principle as deduct. The deduct modal and
barcode-scan-to-deduct flow gain the same location picker, shown only when needed. The
edit modal drops its quantity/location fields (no longer a single value to edit) — stock
changes happen via qty +/-/modal per location; the add modal keeps a single
location+quantity picker for the item's initial stock entry. The details modal gains a
per-location breakdown. Issue #5's manual-add duplicate "Use this" flow now passes the
chosen location through to the quantity-add call.

**Files:** `db-migrations.js`, `item-matching.js` (quantity field now reflects the
aggregate), `server.js` (item query helpers + the endpoints listed above),
`public/index.html` (tabs/cards/qty modal/deduct modal/edit modal/details modal), new
`test/item-locations.test.js`, extensions to `test/invoices.test.js`,
`test/db-migrations.test.js`, and a new `test-e2e/multi-location.spec.js`.

**Pre-change backup:** live DB snapshot + `main` tag before the checkpoint commit, per
CLAUDE.md's pre-change-backup rule for schema changes (same read-only `docker cp`
approach the user authorised during the prior sprint) —
`inventory-2026-08-17-0731-pre-multilocation.db`.

**Two bugs found and fixed during implementation, beyond the original plan:**
- `resolveTargetLocation` initially couldn't distinguish "location omitted from the
  request" (should auto-infer) from "location explicitly sent as `null`/`''`" (should
  target the unassigned bucket) — both fell through the same branch, so an explicit
  request for the unassigned bucket on a multi-location item silently landed on
  whichever location happened to be inferred instead. Caught by a test that passed for
  the wrong reason (single-location item at the time of the assertion, masking the bug);
  fixed and the test strengthened to force a genuine multi-row scenario before asserting.
- `POST /api/invoices/commit`: `existingItems` entries weren't updated after a matched
  item's `lowest_price` changed, so a third line item matching the same item within one
  invoice would compare against a stale lowest price. One-line fix
  (`matchedItem.lowest_price = newLowest`) in the same code path already being edited
  for the location upsert.

**Deviation from the original plan:** used a hand-rolled derived value / partial-index
upsert helper (`upsertItemLocationQuantity`) shared by the quantity/deduct/invoice-commit
endpoints instead of raw `INSERT ... ON CONFLICT` SQL in each call site — simpler to get
right than SQLite's partial-index upsert target syntax, and it's the same helper the
plan's tests already exercise directly.

## 0.16 - 2026-08-16 - Docs: reflect deployed auth model

Docs-only change, no code. `CLAUDE.md` constraints #2 and #8 updated to describe the
now-deployed JWT auth (previously written as "future state" alongside the 0.15 work)
as current fact: NPM was kept in place but its Authentik header/auth settings were
removed, so it's now a plain pass-through in front of the app's own JWT auth. Added a
note that the long-term goal is a React Native rewrite of the front end using this API,
and that issuing the apps — not this auth conversion — is the trigger for the 1.0 MAJOR
bump.

## 0.15 - 2026-08-15 - API + in-app auth conversion

**Context:** step one of the eventual React Native rewrite. Removes Authentik/NPM from
the app's auth path; the app becomes the only gate. Supersedes constraints #2 and #8
from `CLAUDE.md` for this task only; everything else in it (SQLite pragmas, `DB_PATH`,
test seam, LLM model default, camera Permissions-Policy, port binding) is unchanged.

**Route audit:** the app is already almost entirely a JSON `/api/...` backend (28
routes, all JSON — no server-rendered HTML routes exist). "API extraction" therefore
needs no route restructuring, just an auth gate in front of the existing routes, plus
the existing static file serving of `public/` and `/uploads`.

**Design:**
- New env vars: `AUTH_USERNAME`, `AUTH_PASSWORD_HASH` (bcrypt), `JWT_SECRET`.
- `POST /api/auth/login`: checks credentials, returns a JWT (30 day expiry) on success.
  Rate-limited to 5 attempts/15 min per IP using the existing in-memory
  `createRateLimiter` helper already in `server.js` (no new rate-limit dependency).
- `GET /api/health`: new public alias, same body as the existing `/healthz` (which is
  kept as-is, outside `/api`, unauthenticated, for existing monitoring).
- `requireAuth` middleware verifies `Authorization: Bearer <token>` and is mounted on
  `/api` AFTER the login/health routes are registered, so those two stay reachable
  without a token while everything else under `/api` requires one.
- Socket.IO: `io.use(...)` handshake middleware verifies a JWT passed as
  `socket.handshake.auth.token`; unauthenticated sockets are rejected at connect time.
- New deps: `jsonwebtoken` (JWT sign/verify) and `bcryptjs` (pure-JS bcrypt, avoids
  adding another native-compiled dependency alongside better-sqlite3/sharp).
- Frontend: existing (unused) `apiFetch()` helper in `public/index.html` is repurposed
  to attach the `Authorization` header from `localStorage` and to clear the token +
  show a login screen on a 401; the ~19 raw `fetch('/api/...')` call sites are switched
  to call it. A login form overlay is added; the socket client passes the stored token
  via `io({ auth: { token } })` and reconnects with it after login.
- Test-only credentials (vitest `test/setup.js`, Playwright `test-e2e/global-setup.mjs`)
  are fixed, hardcoded, throwaway values distinct from production secrets. Existing
  vitest files call a small `api(app)` wrapper (in `setup.js`) instead of raw
  `request(app)` so every existing test keeps working with a valid token attached.
  Playwright tests get a pre-signed token via `storageState` (page-side) and
  `extraHTTPHeaders` (the `request` fixture) so existing specs don't need per-test
  login flows; one new `test-e2e/auth.spec.js` exercises the real login form logged-out.
- No database schema change.

**Implemented as planned**, plus two fixes discovered along the way:
- `test-e2e/auth-fixtures.mjs` was renamed to `.cjs`: Playwright bundles `.mjs`
  config/setup files through esbuild for static export detection, which proved
  unreliable for a file whose exports are computed at module load (`bcrypt.hashSync`,
  originally `crypto.randomBytes` for `JWT_SECRET`). A plain CommonJS file plus Node's
  native ESM-imports-CJS interop resolved it cleanly.
- That same fixture's `JWT_SECRET` is a fixed string, not randomly generated per run:
  `playwright.config.js` and `test-e2e/global-setup.mjs` load it through separate
  transform contexts, so a value computed with fresh randomness at module-load time
  isn't guaranteed to come out identical in both, and the token minted in config must
  match the secret given to the spawned test server. `AUTH_PASSWORD_HASH` didn't need
  the same fix (bcrypt hashes their own random salt, but only the server's copy is ever
  checked against anything).
- `jsonwebtoken` is used for signing/verifying on the server; the e2e fixture mints its
  token with a small hand-rolled HS256 signer (`node:crypto`) instead of importing
  `jsonwebtoken` directly, for the same esbuild/bundling reason above (`jsonwebtoken`
  pulls in `jws` → `safe-buffer`, which does a conditional `require('buffer')` that
  esbuild's CJS-in-ESM shim can't satisfy). Cross-checked against `jsonwebtoken`'s own
  `verify()` before use.

Full suite green: 39 backend (vitest, incl. 10 new auth tests) + 9 e2e (Playwright,
incl. 2 new login-flow tests) tests. Not yet deployed to production - pending the
port-2627 isolated test-container verification and production secrets.

## 0.14 - 2026-08-11
- Made the location tab bar dynamic instead of hardcoded, in `public/index.html`. Previously the tab bar and its filtering logic were built from a fixed array of location names, so a newly added location never got a tab and renaming/deleting a default location broke its filter.
  - The tab bar now always shows three fixed special tabs (All Inventory, Grocery List, Ignored Out-of-Stock) plus one tab per entry in the `locations` array (from `GET /api/locations`), inserted between All Inventory and Grocery List, in API order.
  - `currentTab` is now a `{ type: 'all' | 'location' | 'grocery' | 'ignored', id }` object rather than a tab-label string; location tabs filter by `item.location_id === currentTab.id` instead of matching `item.location_name` against a hardcoded string, so renames no longer break filtering.
  - The tab bar re-renders whenever `locations` is refetched (initial load and the existing `locations_updated` socket handler), so added/renamed/deleted locations are reflected immediately. If the selected location is deleted, the view falls back to "All Inventory".
  - Added `test-e2e/location-tabs.spec.js`: asserts the three special tabs are always present, that a location seeded via `POST /api/locations` gets its own tab and correctly filters items to that location (and excludes items in other locations), and that renaming/deleting a location updates/removes its tab with a sensible fallback.
  - Scope: `public/index.html` and `test-e2e/` only; `server.js` untouched. Full suite green: 29 backend (vitest) + 7 e2e (Playwright) tests.

## 0.13 - 2026-08-10
- Added a `version` field to the `GET /healthz` response (now `{ status: 'ok', version: '0.13' }`), so a running deployment's version can be verified against this changelog. Updated the backend healthz test to assert on `status` and `version` individually rather than an exact body match.

## 0.12 - 2026-08-10
- Stage 3-lite: graceful shutdown (fixes slow stop), /healthz endpoint, rate limiting, and security headers with camera allowed.

## 0.11 - 2026-08-09
- Stage 2: fixed barcode scanner (context capture), select-before-deduct behavior, XSS escaping; added Playwright e2e suite.

## 0.10 - 2026-08-09
- Stage 1: data-integrity fixes (validation, transactions, guarded deduct, 404s, price recalculation).

## 0.9 - 2026-08-09
- Test harness: Stage 1 red baseline (23 tests).

## 0.8 - 2026-08-09
- Multi-stage build to slim final image (drop compiler toolchain from runtime).

## 0.7 - 2026-08-08
- Added synchronous=FULL pragma for power-loss durability.

## 0.6 - 2026-08-08
- Bumped GitHub Actions to Node 24 versions (checkout v5, login v4, build-push v7).

## 0.5 - 2026-08-08
- Containerised Butler: added Dockerfile, GHCR workflow, dockerignore; externalised LLM config and port.

## 0.4 - 2026-07-26
- Changed server port to 2626 and updated log message.

## 0.3 - 2026-07-26
- Changed page title from 'Household Inventory' to 'Terrible Butler'.

## 0.2 - 2026-07-26
- Removed SQLite WAL files from tracking.

## 0.1 - 2026-07-26
- Initial commit of household inventory app.
