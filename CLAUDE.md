# Butler — project context

Household food inventory web app ("Terrible Butler"). Node.js 24 (Active LTS; `engines`,
`.nvmrc`, Dockerfile) / Express 5 / better-sqlite3 /
Socket.IO, with a React 19 / Vite / Tailwind 4 client in `client/` (built to `client/dist`, served at `/`;
html5-qrcode barcode scanning, Cropper.js 2). The old single-file `public/index.html` front end and its
`/legacy` route were retired (#59); `public/` now only holds the `uploads/` mount point. Product labels are parsed by
Claude through the Anthropic Messages API (see constraint 6); invoices by the deterministic Coles/Woolworths
parsers, with Claude only classifying/matching lines they cannot place.

Use British/Australian English in all writing, comments, and UI text.

Long-term goal: full React Native rewrite of the front end, using this API. Issuing the
apps is the trigger for the first MAJOR version bump to 1.0 in `CHANGELOG.md` (per the
versioning rules — MAJOR is never auto-incremented, only advanced on an explicit
user-declared milestone). The auth/API conversion below is a preparatory step, not that
milestone itself.

## Layout

- Repo (in container): `/projects/butler`
- GitHub: `kmbrimble/terriblebutler`
- Live container: `terrible-butler`, port 2626, `https://butler.kiztigs.com`
- Live data: `/mnt/user/appdata/butler/data/inventory.db` (host) — **never touched by tests**
- Live uploads: `/mnt/user/appdata/butler/uploads` (host) → `/app/public/uploads` in the container = `UPLOADS_DIR`

## Test commands

- **Backend (Vitest + supertest):** `npm test` — tests in `test/`
- **Client unit (Vitest):** `npm run test:client` — tests beside the code in `client/src/`
- **Frontend (Playwright):** `npm run test:e2e` — tests in `test-e2e/`

Run `npm test` for any change. Also run `npm run test:e2e` if `client/` or anything
affecting browser behaviour changed.

Tests use a temporary database via the `DB_PATH` environment variable. They must never read or
write the live database or uploads directory.

## Server layout

`server.js` is a thin composition root — it wires modules together in a specific order and
re-exports `{ app, server, db }`. It does not itself contain route handlers, DB setup, or
middleware logic. The actual code lives in:

- `lib/config.js` — env-derived constants (`APP_VERSION`, `UPLOADS_DIR`, `JWT_SECRET`, `AUTH_USERNAME`,
  `AUTH_PASSWORD_HASH`, upload size limits, LLM defaults, `PORT`). Startup fails (non-zero exit,
  variable named, value never printed) unless `AUTH_PASSWORD_HASH` is a bcrypt hash and
  `JWT_SECRET` is at least 32 characters.
- `lib/database.js` — `openDatabase()`: pragmas, schema, migrations, default-location seeding.
- `lib/auth-state.js` — `createAuthState(db)`: persisted token epoch, `revokeAllSessions()`,
  startup credential-fingerprint check.
- `lib/realtime.js` — `createRealtime(server, authenticateToken)`: Socket.IO construction,
  handshake auth, Origin enforcement (`allowRequest`; `APP_ORIGIN` or same-origin), per-socket
  credential, `disconnectSockets`, `watchExpiry` (a socket never outlives its credential), `broadcastUpdate`. Takes the HTTP server and `authenticateToken` as
  parameters specifically to break the `broadcastUpdate` → `io` → `server` → `app` → routes
  dependency cycle — the composition root builds `server` from `app`, then calls this before
  registering any routes.
- `lib/middleware.js` — security headers (incl. the CSP), the rate-limiter factory and its configured
  instances (`generalApiRateLimiter`, `mutationRateLimiterMiddleware`, `llmRateLimiter`,
  `loginRateLimiter`), and `createAuth(db, authState)` (`authenticateToken` returns the credential
  or null, `requireAuth`, `requireHouseholdJwt`; `hashDeviceToken` is a separate export). Multer
  configs live in `lib/uploads.js`.
- `lib/domain-helpers.js` — item shaping/validation (`createDomainHelpers(db)` plus the pure
  helpers `cleanText`, `finiteNumber`, `parseIntOrNull`, `normaliseBarcode`,
  `sendMutationError` (only a `ValidationError` carries its message to the client; anything else is a correlation-id 500), `parseItemLocations`, and the `TOTAL_QUANTITY_SQL` /
  `LOCATIONS_BREAKDOWN_SQL` fragments).
- `lib/llm-client.js` — `callClaudeForJSON` (forced strict tool-use call to the Anthropic
  Messages API), `classifyLinesWithLLM` (batched), `matchLinesWithLLM`.
- `lib/uploads.js` — everything about user-supplied files: multer into a private scratch dir
  (`UPLOAD_TMP_DIR`), sharp validation/re-encode (WebP, metadata stripped, 50 MP cap, loaders
  other than jpeg/png/webp blocked; HEIC/HEIF deliberately unsupported), `UPLOADS_DIR` storage, signed `/media/:name` delivery
  (HMAC key HKDF-derived from `JWT_SECRET`, 1-2 h URLs), and the 20-page invoice PDF bound.
  `items.image_path` holds the stored id; API/Socket.IO payloads carry a signed URL instead (via
  `parseItemLocations`). There is no static `/uploads` and, for now, no endpoint that stores
  client images (the label scanner only decodes and discards); `storeUploadedImage` and the signed
  delivery are the tested base for a future photo feature.
- `lib/shutdown.js` — `setupGracefulShutdown({ db, io, server })`.
- `routes/*.js` — one file per route group (`health`, `auth`, `locations`, `categories`,
  `items`, `price-history`, `uploads`, `invoices`), each exporting a `register*(app, deps)`
  function called from `server.js` in the exact order the routes must be mounted.

`test/module-seam.test.js` snapshots the registered route table (method + path, in order) and
asserts `{ app, server, db }` are still exported against `DB_PATH` — treat a failure there as a
sign a change altered request-handling behaviour, not just structure.

## Non-negotiable constraints

These MUST be preserved. Generic "best practice" refactors break them; do not apply patterns
from outside this project without checking against this list.

1. **Listen on all interfaces, port 2626.** `lib/config.js` sets
   `PORT = process.env.PORT || 2626`, and `server.js` calls `server.listen(PORT, ...)` with NO
   host argument. NEVER bind to `127.0.0.1` or any loopback address — it makes the app
   unreachable by Nginx Proxy Manager and by the LAN.
2. **App-level auth via JWT.** `POST /api/auth/login` (`routes/auth.js`) checks
   `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` (bcrypt) and returns a 30-day JWT. All `/api/*`
   routes require `Authorization: Bearer <token>` (`requireAuth` in `lib/middleware.js`)
   except `/api/auth/login` and `/api/health`. Rate-limited to 5 attempts/15min on login.
   Socket.IO validates the token on handshake (`lib/realtime.js`). Household JWTs carry a
   `jti` and the token epoch `ver` (`lib/auth-state.js`); a stale epoch is rejected, so
   `POST /api/auth/revoke-all` or a changed `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` (detected at
   startup) ends every session and device token. Only a household JWT can mint device tokens.
   Stored images are readable only through short-lived signed `/media/:name` URLs (`lib/uploads.js`).
   Do not remove this auth layer or make routes public without checking with the user first.
3. **Preserve the SQLite pragmas** (`lib/database.js`): `journal_mode = WAL`,
   `synchronous = FULL`, `foreign_keys = ON`.
4. **Preserve `DB_PATH`** (`lib/database.js`):
   `const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');`
   This is what lets tests use a temp DB. Never hardcode the database path.
5. **Preserve the test seam:** `server.listen` in `server.js` wrapped in
   `if (require.main === module) { ... }`, and the file ending with
   `module.exports = { app, server, db };`. This lets supertest import the app without
   starting a listener.
6. **Vision/text LLM calls go through the Anthropic Messages API** (`lib/llm-client.js`
   `callClaudeForJSON()`, official `@anthropic-ai/sdk`), not a self-hosted Ollama model —
   that path was removed (fixes #34). Default model is `claude-haiku-4-5`
   (`lib/config.js` `getAnthropicModel()` — reads `process.env.ANTHROPIC_MODEL` live rather
   than caching it, since a cached value would ignore a per-test override set after module
   load). `ANTHROPIC_API_KEY` is required and read by the SDK directly from the
   environment — never hardcode it or log it. Structured JSON is guaranteed via a forced,
   `strict: true` tool call, not free-text parsing.
7. **Camera must stay allowed.** The `Permissions-Policy` header (`securityHeaders` in
   `lib/middleware.js`) must include `camera=(self)`. Removing it breaks the barcode scanner.
   There is a test guarding this; do not weaken it.
8. **Never expose the Node port raw to the internet.** Current access path (may change
   again): [Cloudflare / LAN] → Nginx Proxy Manager (plain reverse proxy — Authentik
   header/auth settings were removed, so NPM now passes straight through) →
   `terrible-butler` on its unique port → app's own JWT auth.

## Conventions

Project rules that are not on the non-negotiable list above. They are enforced by tests, but
loosening one is a normal, deliberate change rather than a stop-and-ask.

- **Strict CSP, no third-party runtime assets.** `securityHeaders` sends a
   `Content-Security-Policy` (`script-src 'self'`, `style-src 'self'`, no `unsafe-inline`/`unsafe-eval`).
   Nothing may load from a third-party origin: fonts are bundled (`@fontsource/*`, OFL licences in
   `client/public/font-licences`), and the pre-paint theme bootstrap is the external
   `client/public/theme-init*.js`, not an inline script. Every e2e spec imports `test` from
   `test-e2e/csp-guard.js`, which fails the test on any CSP violation; never import from
   `@playwright/test` directly. A new feature needing a looser directive must widen it deliberately in
   `lib/middleware.js` and `test/csp.test.js`.

## Database notes (read before any schema change)

- Schema versioning is `PRAGMA user_version` via `db-migrations.js`: an append-only list of
  numbered migrations (currently 6), each idempotent and safe on a populated database. Never
  edit an applied migration; add a new one, and state the schema change in the changelog.
  Migration 5 added `auth_state` (a single row: token epoch + credential fingerprint, never the
  hash) and `device_tokens.issued_by_jti` (which household JWT minted each device token).
  Migration 6 added `invoice_imports.dedupe_key` (UNIQUE index; `retailer|no:<invoice number>`, else
  `retailer|sha256:<normalised PDF text>`, so a re-import gets a 409 `duplicate_invoice`),
  `invoice_import_lines.category_cleared` / `location_cleared` (an explicit "none" must not revert to the
  suggestion at commit), and triggers rejecting negative `item_locations.quantity` (SQLite cannot add a
  CHECK without a table rebuild). Cancelling an in-progress import frees its key; a committed one keeps it.
- Live schema tables: `items`, `locations`, `categories`, `price_history`, `device_tokens`,
  `auth_state`, the invoice-import staging tables, plus a **vestigial `inventory` table**
  (`description, size, quantity`) left over from an early version. Confirm nothing references
  `inventory` before touching it; do not write to it. `items.location_id` and `items.quantity`
  are vestigial too: `item_locations` is the source of truth.
- `invoice_imports` and `invoice_import_lines` hold the deterministic Coles/Woolworths
  import's server-side staging state (added alongside that flow; confirmed live-empty at the
  time of the stage-4 React port, 0 rows in each). It is the only invoice path: the old plain
  LLM-parse upload (`/api/invoices/parse` + `/api/invoices/commit`) was removed because nothing
  used it after `/legacy` was retired and it had no duplicate protection. There is still no
  dedicated `vendor` table; vendors are free-text in `price_history.vendor`.

## Container runtime (non-root)

The image starts `docker-entrypoint.sh` as root only to `chown` the writable paths
(`/app/data` or the dir of `DB_PATH`, `UPLOADS_DIR` (default `/app/public/uploads`), `LOG_DIR` /
`/app/logs`) to `PUID:PGID`, then `exec setpriv` drops privileges for good (no-new-privs) and
runs `node server.js` as PID 1, so SIGTERM reaches `lib/shutdown.js` directly.

- `PUID` / `PGID` env vars, defaults `99` / `100` (unRAID nobody:users). Must be numeric and
  non-zero; the entrypoint refuses to run the app as root.
- Existing root-owned files in the bind mounts (e.g. `inventory.db`) are chowned in place on
  start; already-correct entries are skipped.
- The base image is pinned by digest (`ARG NODE_IMAGE` in the Dockerfile, tag `node:24-slim`);
  Dependabot bumps it. Debian apt packages are deliberately not version-pinned (builder stage
  only, discarded; pinned apt versions disappear from mirrors and break builds).

## Client IP and rate limits

- `TRUST_PROXY` (`lib/config.js`, validated at startup, logged at listen): unset = trust no
  forwarded headers (`req.ip` is the socket peer). Accepts a hop count or a comma-separated
  list of IPs/CIDRs/named ranges; `true`, `*` and `/0` ranges are refused. Prefer the address
  list: a hop count also trusts the direct peer, and port 2626 is published on all interfaces,
  so a direct caller could spoof `X-Forwarded-For`. Rate-limit keys use the resolved IP
  (IPv4-mapped IPv6 folded). Recommended value for this deployment (Nginx Proxy Manager on the Docker bridge networks): `172.17.0.0/16,172.18.0.0/16`, set in the unRAID template.
- `POST /api/invoices/import` shares the LLM limiter (10/min). `INVOICE_IMPORT_MAX_LINES`
  (default 250) caps parsed lines per import; classification is batched (25 lines/call, 3 in
  flight) and failures come back as `warnings` in the import response.
- The action log (`logger.js`) records only authenticated, non-throttled mutating calls
  (bodies redacted recursively and truncated); logins are body-less `event: login` audit lines.
  500 responses carry a `correlation_id`; the full error is in the server log under that id.

## Pre-change backup

Before any change that alters the database schema or write paths, take the snapshot yourself
(the user has confirmed this is now standard process, not something to ask permission for each
time) — do not just remind them to do it manually. Steps:

1. Run a live-safe SQLite backup **inside the `terrible-butler` container**, not a raw file
   copy — the live DB runs in WAL mode, so copying `inventory.db` alone can miss uncommitted
   WAL frames. Use better-sqlite3's online backup API (it's already a dependency in the
   container image):
   ```
   docker exec terrible-butler node -e "
     const Database = require('better-sqlite3');
     const db = new Database('/app/data/inventory.db', { readonly: true });
     db.backup('/app/data/inventory-YYYY-MM-DD-<short-description>.db')
       .then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
   "
   ```
2. The `terrible-butler` container only has `/app/data` and `/app/public/uploads` bind-mounted
   (not the backup destination), so relocate the file with a throwaway container that mounts
   both real host paths directly — this only works because the docker daemon reachable from
   this environment *is* the unRAID host's daemon (confirm via
   `docker inspect terrible-butler --format '{{json .Mounts}}'`, source paths should read
   `/mnt/user/appdata/butler/...`):
   ```
   docker run --rm \
     -v /mnt/user/appdata/butler/data:/src:ro \
     -v /mnt/user/Kieren/Backup/unRAID/butler:/dest \
     alpine cp /src/inventory-YYYY-MM-DD-<short-description>.db /dest/
   ```
3. Delete the temp copy left in `/app/data` afterward
   (`docker exec terrible-butler rm /app/data/inventory-YYYY-MM-DD-<short-description>.db`) —
   only `inventory.db`/`-wal`/`-shm` should live there day to day.
4. Verify before trusting it: `PRAGMA integrity_check;` via a throwaway container with the
   backup destination mounted **read-write** (SQLite needs to create a temp/journal file next
   to the DB even just to read it — a `:ro` mount makes `sqlite3` fail to open the file
   entirely, not fail safely):
   ```
   docker run --rm -v /mnt/user/Kieren/Backup/unRAID/butler:/dest alpine sh -c \
     "apk add --no-cache sqlite >/dev/null && sqlite3 /dest/<file>.db 'PRAGMA integrity_check;'"
   ```

If `docker`/`docker exec` isn't reachable from wherever this is being run, or the classifier/
permission layer blocks it, fall back to asking the user to run it or to grant the permission —
don't try to route around a permission block via another tool.

## Recovery: forgotten household login password

There is no in-app password reset flow — the household login is a single shared
username/password, and this is intentionally the only recovery path:

1. Run `node scripts/generate-password-hash.js '<new password>'` (in the repo, or via
   `docker exec terrible-butler node scripts/generate-password-hash.js '<new password>'`
   against the live container) to print a bcrypt hash.
2. Set that hash as the `AUTH_PASSWORD_HASH` environment variable on the `terrible-butler`
   container in unRAID's Docker template (update `AUTH_USERNAME` too if it's changing).
3. Force update / restart the container for the new env vars to take effect. On that start
   the changed credential is detected and every JWT and device token is revoked (everyone
   logs in again). Optional env `APP_ORIGIN` (e.g. `https://butler.kiztigs.com`) pins the
   allowed Socket.IO origin; unset means same-origin (Origin host must equal the Host header).

## Deploy and verify

1. Push to `main`.
2. Watch the GitHub Actions build: `gh run list --limit 1`, then
   `gh run watch <id> --exit-status`.
3. On success, tell the user: **force update the `terrible-butler` container in unRAID's Docker
   tab.** The `butler-proxynet-autoconnect` User Script re-attaches `proxynet` automatically, so
   no 502 is expected.
4. For UI changes, tell the user to eyeball `https://butler.kiztigs.com` — the automated
   Playwright tests confirm behaviour, not visual correctness.

## Scope notes

- Do not modify `.github/workflows/` unless the request is explicitly about CI.
- Do not modify the live container, live database, or live uploads directory.
