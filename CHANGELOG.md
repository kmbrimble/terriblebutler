# Changelog

The minor version (after the dot) is an integer counter that increments by 1 each change: 0.1, 0.2 ... 0.9, 0.10, 0.11, and so on. The major version (before the dot) is NOT auto-incremented — it only advances when the user manually declares a milestone.

## [Unreleased]

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
