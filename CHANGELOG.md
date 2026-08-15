# Changelog

The minor version (after the dot) is an integer counter that increments by 1 each change: 0.1, 0.2 ... 0.9, 0.10, 0.11, and so on. The major version (before the dot) is NOT auto-incremented — it only advances when the user manually declares a milestone.

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
