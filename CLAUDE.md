# Butler — project context

Household food inventory web app ("Terrible Butler"). Node.js / Express / better-sqlite3 /
Socket.IO, with a single large `public/index.html` front end (Tailwind via CDN, html5-qrcode
barcode scanning, Cropper.js, Chart.js). Product labels and invoices are parsed via a local
vision LLM.

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
- Live uploads: `/mnt/user/appdata/butler/uploads` (host)

## Test commands

- **Backend (Vitest + supertest):** `npm test` — tests in `test/`
- **Frontend (Playwright):** `npm run test:e2e` — tests in `test-e2e/`

Run `npm test` for any change. Also run `npm run test:e2e` if `public/index.html` or anything
affecting browser behaviour changed.

Tests use a temporary database via the `DB_PATH` environment variable. They must never read or
write the live database or uploads directory.

## Server layout

`server.js` is a thin composition root — it wires modules together in a specific order and
re-exports `{ app, server, db }`. It does not itself contain route handlers, DB setup, or
middleware logic. The actual code lives in:

- `lib/config.js` — env-derived constants (`APP_VERSION`, `JWT_SECRET`, `AUTH_USERNAME`,
  `AUTH_PASSWORD_HASH`, upload size limits, LLM defaults, `PORT`).
- `lib/database.js` — `openDatabase()`: pragmas, schema, migrations, default-location seeding.
- `lib/realtime.js` — `createRealtime(server, authenticateToken)`: Socket.IO construction,
  handshake auth, `broadcastUpdate`. Takes the HTTP server and `authenticateToken` as
  parameters specifically to break the `broadcastUpdate` → `io` → `server` → `app` → routes
  dependency cycle — the composition root builds `server` from `app`, then calls this before
  registering any routes.
- `lib/middleware.js` — security headers, the rate-limiter factory and its configured
  instances (`generalApiRateLimiter`, `mutationRateLimiterMiddleware`, `llmRateLimiter`,
  `loginRateLimiter`), the multer upload configs, and `createAuth(db)` (`authenticateToken`,
  `requireAuth`, `hashDeviceToken`).
- `lib/domain-helpers.js` — item shaping/validation (`createDomainHelpers(db)` plus the pure
  helpers `cleanText`, `finiteNumber`, `parseIntOrNull`, `normaliseBarcode`,
  `sendMutationError`, `parseItemLocations`, and the `TOTAL_QUANTITY_SQL` /
  `LOCATIONS_BREAKDOWN_SQL` fragments).
- `lib/llm-client.js` — `callClaudeForJSON` (forced strict tool-use call to the Anthropic
  Messages API), `classifyLineWithLLM`.
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
   Socket.IO validates the token on handshake (`lib/realtime.js`). Do not remove this auth
   layer or make routes public without checking with the user first.
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

## Database notes (read before any schema change)

- Live schema tables: `items`, `locations`, `categories`, `price_history`, plus a **vestigial
  `inventory` table** (`description, size, quantity`) left over from an early version. Confirm
  nothing references `inventory` before touching it; do not write to it.
- **There is no migrations table and no schema version tracking.** Columns have historically
  been added by ad-hoc `ALTER TABLE ADD COLUMN` (for example `last_price`, `lowest_price`).
  Any schema change must therefore be idempotent and safe to apply to an existing populated
  database. State explicitly in the changelog what schema change was made.
- `invoice_imports` and `invoice_import_lines` hold the deterministic Coles/Woolworths
  import's server-side staging state (added alongside that flow; confirmed live-empty at the
  time of the stage-4 React port, 0 rows in each). The plain LLM-parse invoice upload
  (`/api/invoices/parse` + `/api/invoices/commit`) is unrelated and keeps its staging list
  entirely client-side — no table backs it. There is still no dedicated `vendor` table;
  vendors are free-text in `price_history.vendor`.

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
3. Force update / restart the container for the new env vars to take effect.

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
- `public/index.html` is large; use `repository-reader` to locate the relevant section rather
  than reading the whole file into context.
