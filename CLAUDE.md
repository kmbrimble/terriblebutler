# Butler — project context

Household food inventory web app ("Terrible Butler"). Node.js 24 (Active LTS; `engines`,
`.nvmrc`, Dockerfile) / Express 5 / better-sqlite3 /
Socket.IO, with a React 19 / Vite / Tailwind 4 client in `client/` (built to `client/dist`, served at `/`;
html5-qrcode barcode scanning, Cropper.js 2). The old single-file `public/index.html` front end and its
`/legacy` route were retired (#59); there is no `public/` in git any more: the uploads directory (`UPLOADS_DIR`, default
`public/uploads` under the app root) is created at run time and is where the container's uploads volume mounts. Product labels are parsed by
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

`npm test` also runs ShellCheck over every `*.sh` (`test/shellcheck.test.js`). ShellCheck 0.11.0 is fetched once into `node_modules/.cache`
from the official GitHub release and its SHA-256 is verified against a value pinned in `scripts/ensure-shellcheck.js` (needs network the
first time, and `tar` with xz or `python3` to unpack; or set `SHELLCHECK_BIN`). Scanner hygiene: `semgrep --config p/default` and
`hadolint Dockerfile` are kept clean; a justified false positive gets an inline `nosemgrep: <rule-id> -- reason` (checked by
`test/repo-config.test.js`).

Run `npm test` for any change. Also run `npm run test:e2e` if `client/` or anything
affecting browser behaviour changed.

Tests use a temporary database via the `DB_PATH` environment variable. They must never read or
write the live database or uploads directory.

## Server layout

`server.js` is a thin composition root — it wires modules together in a specific order and
re-exports `{ app, server, db }`. It does not itself contain route handlers, DB setup, or
middleware logic. The actual code lives in the top-level modules `logger.js` (action log, below),
`backup.js` (nightly backups), `db-migrations.js` (migrations and the idempotent startup SQL),
`item-matching.js` (duplicate hierarchy — a barcode/name shared by several items is never auto-applied —, LLM-candidate selection, fuzzy-query clipping) and `llm-schema.js`
(validation of LLM output), `parsers/` (`router.js` picks Coles or Woolworths by ABN; `coles.js`,
`woolworths.js`, `shared.js` — deterministic and linear in the input, guarded by `test/parser-complexity.test.js`),
`scripts/` (`generate-password-hash.js`, `docker-smoke.sh`, `ensure-shellcheck.js`, `apply-stocktake.js`), and `lib/`:

- `lib/config.js` — env-derived constants (`APP_VERSION`, `UPLOADS_DIR`, `JWT_SECRET`, `AUTH_USERNAME`,
  `AUTH_PASSWORD_HASH`, upload size limits, LLM defaults, `PORT`). Startup fails (non-zero exit,
  variable named, value never printed) unless `AUTH_PASSWORD_HASH` is a bcrypt hash with a cost of
  10-31 and `JWT_SECRET` is machine-generated: at least 64 hexadecimal characters (32 bytes, `openssl rand -hex 32`). The
  decoded bytes (`JWT_KEY`) are the key for JWT signing and the HKDF input for the media-URL key; the hex string itself is never used as a key.
- `lib/database.js` — `openDatabase()`: pragmas, schema, migrations, default-location seeding.
- `lib/auth-state.js` — `createAuthState(db)`: persisted token epoch, `revokeAllSessions()`,
  startup credential-fingerprint check (login credential AND the JWT signing key: the stored value is `<credential digest>.<HMAC of a fixed label under the key>`, never the hash or the key).
- `lib/realtime.js` — `createRealtime(server, authenticateToken, …, limits)`: Socket.IO construction, connection limits (handshake
  rate `SOCKET_HANDSHAKE_RATE_LIMIT_MAX` 60/min, open sockets `SOCKET_MAX_PER_CLIENT` 20 and `SOCKET_MAX_TOTAL` 200, keyed exactly as the
  Express limiters key clients — `proxy-addr` over the same compiled `TRUST_PROXY`, IPv6 /64 — and counted at the engine level so a
  socket that never authenticates still counts; a slot is reserved atomically in `allowRequest` and released on connection error, after a 10 s TTL, or
  when the engine session closes, so a burst cannot overshoot the cap and nothing leaks; a token-refused session is closed by the server),
  handshake auth, Origin enforcement (`allowRequest`; `APP_ORIGIN`, or the full scheme+host+port of the request, taking `X-Forwarded-Proto/Host` only from a `TRUST_PROXY` peer; a missing Origin is allowed, the token is still required), per-socket
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
  helpers `cleanText`, `finiteNumber` (the one numeric rule: a missing value is an error unless the caller
  says `allowNull`/`defaultValue`; bounds `QUANTITY_MAX` 1,000,000, `PRICE_MAX` 100,000, `LINE_TOTAL_MAX`
  10,000,000), `cleanPurchaseDate` (a real `YYYY-MM-DD`, 2000-01-01 to today, stored as
  `price_history.recorded_at`), `strictFlag` (booleans are `true`/`false`/`1`/`0` only), `normaliseBarcode`,
  `sendMutationError` (only a `ValidationError` carries its message to the client; anything else is a correlation-id 500), `parseItemLocations`, and the `TOTAL_QUANTITY_SQL` /
  `LOCATIONS_BREAKDOWN_SQL` fragments). `cleanName` bounds category/location names (100 characters) and `NAME_LIST_MAX` (500)
  bounds how many there can be, because both lists go into every LLM prompt.
- `lib/llm-client.js` — `callClaudeForJSON` (forced strict tool-use call to the Anthropic
  Messages API), `buildPrompt` (every prompt with untrusted text — PDF text, label context, item/category/
  location names — goes through it: random-id data blocks plus a data-not-instructions notice; the strict
  schema remains the primary control), `classifyLinesWithLLM` (batched), `matchLinesWithLLM`. Every Anthropic call runs through one
  process-wide gate (`llmGate`, a `lib/work-gate.js` gate: `LLM_MAX_CONCURRENT` 4 at once, `LLM_QUEUE_MAX` 8 waiting): a full queue is a 503 + `Retry-After`
  for the label scan (upload discarded), and for invoice classification/matching it degrades to the warnings those already produce, never a 500.
- `lib/uploads.js` — everything about user-supplied files: multer into a private scratch dir
  (`UPLOAD_TMP_DIR`, verified at startup: a real directory, not a symlink, runtime-owned, mode 0700, else the
  process refuses to start), sharp validation/re-encode (WebP, metadata stripped, 50 MP cap, loaders
  other than jpeg/png/webp blocked; HEIC/HEIF deliberately unsupported), `UPLOADS_DIR` storage, signed `/media/:name` delivery
  (HMAC key HKDF-derived from `JWT_SECRET`, 1-2 h URLs), and the 20-page invoice PDF bound (text extracted in a worker thread, `lib/pdf-worker.js`, with a hard deadline `PDF_PARSE_TIMEOUT_MS` default 20 s and heap ceiling `PDF_WORKER_MEMORY_MB` default 256; the extracted text is capped inside the worker at `PDF_MAX_TEXT_CHARS`, default 500,000 characters, far above a real invoice, else a 422 — the scratch sweep at startup uses `lstat` and removes symbolic links themselves).
  `items.image_path` holds the stored id; API/Socket.IO payloads carry a signed URL instead (via
  `parseItemLocations`). There is no static `/uploads` and, for now, no endpoint that stores
  client images (the label scanner only decodes and discards); `storeUploadedImage` and the signed
  delivery are the tested base for a future photo feature.
- `lib/pdf-text.js` / `lib/pdf-worker.js` — page-bounded `pdf-parse` extraction and its worker-thread entry point (run by `lib/uploads.js`).
- `lib/invoice-dedupe.js` — `invoiceDedupeKey()`: `retailer|no:<invoice number>`, else `retailer|sha256:<normalised text>`.
- `lib/private-fs.js` — `ensurePrivateDir` / `makePrivate`: everything the app writes to persistent storage (database and WAL/shm, action logs,
  backups, stored images) is created owner-only (dirs 0700, files 0600) whatever the inherited umask. A directory that already exists is never
  chmod'd (DB_PATH can sit in /tmp or on a shared mount).
- `lib/login-backoff.js` — `createLoginBackoff()`: account-level login backstop (delay, never lockout).
- `lib/invoice-retention.js` — uncommitted invoice imports older than `INVOICE_IMPORT_RETENTION_DAYS`
  (default 30, max 3650) are deleted, lines first, at startup and daily; this also frees their duplicate key.
  Committed imports are never touched.
- `lib/work-gate.js` — `createWorkGate({ concurrency, queue })`: the small semaphore with a bounded queue behind `heavyWork`
  in `lib/uploads.js`. PDF extraction, `storeUploadedImage` and the label scanner's image decode/resize all run through it
  (`HEAVY_WORK_CONCURRENCY` default 2, `HEAVY_WORK_QUEUE` default 4); beyond that the request is a 503 with `Retry-After` and
  the upload is discarded. Per-client rate limits cannot bound what many clients ask at once; this does.
- `lib/rate-limit-core.js` — config-free parts of rate limiting (`keyForAddress`: IPv4 / IPv6 /64 fold; `createHitCounter`: the
  bounded fixed-window counter) shared by the Express limiters and the Socket.IO handshake limiter.
- `lib/shutdown.js` — `setupGracefulShutdown({ db, io, server })`.
- `routes/*.js` — one file per route group (`health`, `auth`, `locations`, `categories`,
  `items`, `price-history`, `uploads`, `invoices`), each exporting a `register*(app, deps)`
  function called from `server.js` in the exact order the routes must be mounted. After the last one,
  any other `/api/*` request (any method) is a JSON 404; it sits behind `requireAuth`, so an
  unauthenticated caller gets 401 for real and made-up paths alike. `GET /api/items/search` is bounded
  (query at most 100 characters, at most 50 results, a three-column Fuse index), and so is `GET /api/items/match` (name at most 200,
  barcode at most 128, single values only, else 400). Every fuzzy search clips its pattern to `FUZZY_QUERY_MAX` (100) characters, because
  Fuse's cost is pattern length times item count.

`test/module-seam.test.js` snapshots the registered route table (method + path, in order) and
asserts `{ app, server, db }` are still exported against `DB_PATH` — treat a failure there as a
sign a change altered request-handling behaviour, not just structure.

## Non-negotiable constraints

These MUST be preserved. Generic "best practice" refactors break them; do not apply patterns
from outside this project without checking against this list.

1. **Listen on all interfaces, port 2626.** `lib/config.js` sets
   `PORT` defaults to 2626 (`boundedIntegerEnv('PORT', 2626, 65535, 0)`), and `server.js` calls `server.listen(PORT, ...)` with NO
   host argument. NEVER bind to `127.0.0.1` or any loopback address — it makes the app
   unreachable by Nginx Proxy Manager and by the LAN.
2. **App-level auth via JWT.** `POST /api/auth/login` (`routes/auth.js`) checks
   `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` (bcrypt) and returns a 30-day JWT. All `/api/*`
   routes require `Authorization: Bearer <token>` (`requireAuth` in `lib/middleware.js`)
   except `/api/auth/login` and `/api/health` (status only; the version is shown only to an authenticated caller).
   Login is rate-limited to 5 attempts/15min per client (IPv6 keyed on its /64), plus an account-wide
   progressive delay (`lib/login-backoff.js`; a delay, deliberately not a lockout, so an attacker cannot lock the family out).
   Revoking a device and "Sign out everywhere" require a FRESH LOGIN (owner decision): the household password is
   re-entered in that request, for every credential type, so a stolen device token alone cannot revoke anything. A
   remembered tablet can still cut off a lost phone, but only by someone who knows the password. The check is bcrypt,
   shares the login rate limit and account backoff (a failed re-auth counts as a failed login), answers 403 (never 401,
   which the client reads as an expired session) and is never logged. Listing devices needs any valid credential;
   minting needs a household JWT. The client prompts via `PasswordConfirmDialog`.
   Passwords over 1024 bytes are simply wrong, at login and at re-auth: same backoff slot, same 401/403 as any wrong password,
   and bcrypt is never called. (bcrypt itself only reads the first 72 bytes of a password, so a longer password's tail is
   ignored; the 1024-byte bound exists to stop oversized input, it is not a statement that longer passwords are stronger. It is
   deliberately not 72: a hash made before `generate-password-hash.js` refused long passwords may have been made from a longer one, whose
   owner types the whole thing, and rejecting it would lock them out. Only a password of exactly 72 bytes, whose hash cannot tell a suffix
   from nothing, accepts trailing bytes, which gives nobody who does not already know all 72 bytes anything.)
   `Authorization` is read in one place (`parseBearerToken`), following RFC 7235: the scheme `Bearer` (case-insensitive), one or more spaces, then a single token68 value; anything else is unauthenticated.
   JSON bodies are parsed only under `/api`, after the general/mutation limiters and `requireAuth` (login: after its own limiter), via
   `middleware.jsonBody` (which also restores the `req.body = {}` default); nothing outside `/api` parses a body, and a throttled or
   unauthenticated caller never makes the server buffer one.
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
8. **Never expose the Node port raw to the internet.** Current access path (verified on the live host,
   may change again): `butler.kiztigs.com` is a Cloudflare-proxied DNS record (it does NOT use the cloudflared
   tunnel) → WAN → router port-forward → Nginx Proxy Manager (plain reverse proxy — Authentik header/auth
   settings were removed, so NPM passes straight through; on br0 192.168.0.23 and proxynet 172.18.0.5) →
   `terrible-butler:2626` over the `proxynet` Docker network → app's own JWT auth. LAN clients reach NPM directly.
   See "Client IP and rate limits" for what that means for client addresses.
9. **Strict CSP, no third-party runtime assets.** `securityHeaders` (`lib/middleware.js`) sends a
   `Content-Security-Policy` with `script-src 'self'` and `style-src 'self'`, and no
   `unsafe-inline` / `unsafe-eval`. Nothing may load from a third-party origin: fonts are bundled
   (`@fontsource/*`, OFL licences in `client/public/font-licences`), and the pre-paint theme
   bootstrap is the external `client/public/theme-init*.js`, not an inline script. Every e2e spec
   imports `test` from `test-e2e/csp-guard.js`, which fails the test on any CSP violation; never
   import from `@playwright/test` directly. Do not loosen a directive, add a third-party origin or
   weaken `test/csp.test.js` without checking with the user first.

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
  CHECK without a table rebuild). `QUANTITY_GUARD_SQL` (`db-migrations.js`) is re-run idempotently at every start, and 0.43 added to it
  `item_locations_quantity_max_insert/_update` (refuse a quantity above `QUANTITY_MAX`, 1,000,000, or an *increase* past it; a legacy larger row can
  still be reduced) with no new migration: `IF NOT EXISTS` triggers, no data touched. Changing the number later needs a migration that drops and recreates them. Cancelling an in-progress import frees its key; a committed one keeps it.
- Live schema tables: `items`, `locations`, `categories`, `item_locations` (the stock; source of truth), `price_history`, `device_tokens`,
  `auth_state`, the invoice-import staging tables (`invoice_imports`, `invoice_import_lines`), `invoice_line_match_memory`
  (raw invoice description -> item, learned at commit and consulted at import), plus a **vestigial `inventory` table**
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
(`/app/data` or the dir of `DB_PATH`, `UPLOADS_DIR` (default `/app/public/uploads`), `LOG_DIR`
(default `<dir of DB_PATH>/logs`, i.e. `/app/data/logs`, on the persistent data mount)) to `PUID:PGID`, then `exec setpriv` drops privileges for good (no-new-privs) and
runs `node server.js` as PID 1, so SIGTERM reaches `lib/shutdown.js` directly.

- Persistent data is private to the app user: the entrypoint sets `umask 077` before the privilege drop (and on the already-non-root path),
  and repairs the existing contents of the validated data, uploads and logs paths to directories 0700 and files 0600 (`repair_modes`: `-xdev`,
  `-type d` / `-type f`, so links are neither followed nor changed), scoped exactly like the chown. The app creates its own files the same way
  (`lib/private-fs.js`). Consequence: reading `/mnt/user/appdata/butler/*` on the host needs root (unRAID's root shell and containers running as
  root are fine); `scripts/docker-smoke.sh` asserts the modes, including repair of seeded world-readable leftovers.
- `PUID` / `PGID` env vars, defaults `99` / `100` (unRAID nobody:users). Must be numeric and
  non-zero; the entrypoint refuses to run the app as root.
- Existing root-owned files in the bind mounts (e.g. `inventory.db`) are chowned in place on
  start; already-correct entries are skipped.
- The entrypoint validates `DB_PATH`, `UPLOADS_DIR` and `LOG_DIR` before chowning anything: absolute,
  normalised (letters, digits, `.`, `_`, `-`), strictly inside `/app`, not in the application code
  (`node_modules`, `lib`, `routes`, `parsers`, `scripts`, `client`, and `/app/public` itself — its `uploads/` child is fine), and mutually disjoint (`LOG_DIR` may sit
  inside the data directory, as the default does, but not be or contain it) — otherwise
  it exits non-zero with a message. `UPLOAD_TMP_DIR`, if set, is validated by the app (well-formed, and
  not overlapping those directories inside the container, since it is swept at startup); when it is inside `/app` the entrypoint also checks it
  by the same rules, creates it, chowns it and makes it 0700 (the app user cannot create anything under root-owned `/app`), and outside `/app`
  (the default is under `/tmp`) the app creates it itself. `lib/config.js` `validateStoragePaths` applies the same rules
  (containment when `WRITABLE_ROOT` is set; the Dockerfile sets `/app`). `test/entrypoint.test.js`
  runs the script with stubs and checks both agree; `scripts/docker-smoke.sh` is the manual
  end-to-end image check (uses only `smoketest-` names and named volumes).
- The runtime image copies an explicit allow-list (server modules, `lib`, `routes`, `parsers`,
  `scripts`, built `client/dist`); a new top-level server module must be added to the Dockerfile
  (`test/docker-build-context.test.js` fails otherwise).
- The base image is pinned by digest (`ARG NODE_IMAGE` in the Dockerfile, tag `node:24-slim`);
  Dependabot bumps it. Debian apt packages are deliberately not version-pinned (builder stage
  only, discarded; pinned apt versions disappear from mirrors and break builds).

## Client IP and rate limits

- `TRUST_PROXY` (`lib/config.js`, validated at startup, logged at listen) is **mandatory when `NODE_ENV=production`** (the Dockerfile sets it): the
  proxy's address/CIDR list, a hop count, or the literal `none` (trust no forwarded headers: direct access only); unset or blank refuses to start with a
  message naming the variable, because left unset every client would silently share the proxy's address and so one per-client rate-limit bucket. Outside
  production unset still means trust nothing (tests, local development). `none` = trust no
  forwarded headers (`req.ip` is the socket peer). Accepts a hop count or a comma-separated
  list of IPs/CIDRs/named ranges; `true`, `*` and `/0` ranges are refused. Prefer the address
  list: a hop count also trusts the direct peer, so any caller who can reach the app directly could
  spoof `X-Forwarded-For`. Rate-limit keys use the resolved IP
  (IPv4-mapped IPv6 folded; other IPv6 keyed on its /64). Revoke attempts share the 5/15-minute login limiter (intended: revoking is a fresh login, and a wrong password is a failed login); the client explains a 429 there. `RateLimit-Reset` and `Retry-After` are seconds until the window resets. Every response carries `RateLimit-Policy: <quota>;w=<window seconds>;name="<limiter>"` and a 429 body names the limiter that fired (`limiter`: `api`, `mutation`, `llm`, `login`), so the client words it truthfully. Limits: `GENERAL_API_RATE_LIMIT_MAX` 240, `MUTATION_RATE_LIMIT_MAX` 90, `LLM_RATE_LIMIT_MAX` 10 (per minute), `LOGIN_RATE_LIMIT_MAX` 5 (per 15 minutes), each per client. Bucket maps are capped at 50,000 and eviction never drops a bucket that is over its limit unless every bucket is.
- **Deployment topology and the right `TRUST_PROXY` (verified read-only on the live host, 2026-10-09).** Traffic arrives as Cloudflare-proxied DNS
  → WAN → router port-forward → Nginx Proxy Manager (br0 192.168.0.23, proxynet 172.18.0.5; proxynet is 172.18.0.0/16 with gateway 172.18.0.1)
  → `terrible-butler:2626` over proxynet. NPM's `nginx.conf` trusts the private ranges plus its `ip_ranges.conf` (Cloudflare's) with
  `real_ip_header X-Real-IP`, and the butler proxy host appends `$proxy_add_x_forwarded_for`. Consequences:
  (a) **As it stands** Cloudflare does not send `X-Real-IP`, so NPM's peer address is a Cloudflare edge address, `X-Forwarded-For` ends in that
  edge, and `req.ip` (hence every rate-limit bucket, the action log's `ip` and Socket.IO keying) is the edge, not the visitor: visitors behind one
  edge share a bucket.
  (b) **The right setup:** NPM restores the visitor from `CF-Connecting-IP` for this proxy host (`real_ip_header CF-Connecting-IP;` with
  `set_real_ip_from` limited to Cloudflare's published ranges, so nobody else can set it), so the `X-Forwarded-For` it appends ends in the real
  client; and the app trusts ONLY NPM's proxynet address: `TRUST_PROXY=172.18.0.5` (give NPM a fixed IP on proxynet so this stays true) or, if
  that cannot be pinned, `172.18.0.0/16` — which also trusts the other containers on proxynet (AdGuardHome, Navidrome, Immich, Grafana), any of
  which could then present a forged `X-Forwarded-For` to the app. Express reads `X-Forwarded-For` right to left and stops at the first
  untrusted address, so a client-supplied header is only ever to the left of the address NPM appended.
  (c) **Remove the host publish of port 2626**, so nothing reaches the app except through NPM over proxynet. Never trust `172.17.0.0/16` (docker0:
  its gateway also carries traffic for host-published ports), `true`, `*` or a hop count.
  Until (b) and (c) are done, set `TRUST_PROXY=none` in production (trust nothing): rate limits then key on the peer, which is NPM, and the startup log says so. Unset is not allowed.
- `POST /api/invoices/import` shares the LLM limiter (10/min). `INVOICE_IMPORT_MAX_LINES`
  (default 250) caps parsed lines per import; classification is batched (25 lines/call, 3 in
  flight) and failures come back as `warnings` in the import response.
- The action log (`logger.js`) records only authenticated, non-throttled mutating calls
  (bodies redacted recursively and truncated); logins are body-less `event: login` audit lines.
  500 responses carry a `correlation_id`; the full error is in the server log under that id.
  Action logs default to `<dir of DB_PATH>/logs` (persistent, beside `backups/`), kept 30 days.
  The stdout copy (what `docker logs` shows) is a bounded async stream, not `console.log`;
  `ACTION_LOG_STDOUT=0` disables it.
- Socket.IO handshakes are limited separately (they bypass the Express limiters): `SOCKET_HANDSHAKE_RATE_LIMIT_MAX` (60/min per client),
  `SOCKET_MAX_PER_CLIENT` (20 open) and `SOCKET_MAX_TOTAL` (200 open); refused handshakes are a 403 from engine.io.
- Heavy upload work (PDF extraction, image decode/re-encode) is bounded process-wide: `HEAVY_WORK_CONCURRENCY` (2 at once) and
  `HEAVY_WORK_QUEUE` (4 waiting), else 503 + `Retry-After: 5`. `INVOICE_MATCH_MAX_ITEMS` (400) caps the existing items offered to the
  LLM matcher per import: an inventory that size or smaller is sent whole, a larger one is narrowed to the items sharing rare words with
  the invoice's lines (`item-matching.js` `selectMatchCandidates`). All integer settings (including `PORT`, 0-65535, where 0 means "any free port") accept plain decimal digits only; anything else
  (`1e3`, `0x10`, blanks, out of range) falls back to the default. The one deliberate exception is `TRUST_PROXY` (also mandatory in production, see above): a hop count is also digits-only
  (0-32) but a bad value stops startup instead of falling back, because silently trusting nothing (or something else) would change
  who the rate limiters see.
- Anthropic calls are bounded process-wide by `LLM_MAX_CONCURRENT` (default 4 in flight) and `LLM_QUEUE_MAX` (default 8 waiting), on top of the per-client LLM rate limit. No per-request
  upload telemetry (file sizes, base64 lengths) is logged.
- Anthropic calls use `ANTHROPIC_TIMEOUT_MS` (default 45000, per attempt) and `ANTHROPIC_MAX_RETRIES`
  (default 1); the SDK's own defaults are 10 minutes and 2.
- Nightly DB backups (`backup.js`) are named `inventory-<UTC timestamp>.db`, kept 14 days; the older
  date-only names are still pruned.

### Deployment and published ports

`docker-compose.yml` is a reference file: it does not publish 2626 at all (constraint #8) and attaches the service to the reverse
proxy's external network (`proxynet`); NPM reaches the app at `terrible-butler:2626` over that network, so no host port is needed. The
unRAID template should match: remove the host port mapping for 2626 (and remember `butler-proxynet-autoconnect` re-attaches proxynet). For
local development only, publish it on loopback (`127.0.0.1:2626:2626`), never on all interfaces. `TRUST_PROXY` is required (compose refuses to start without it): NPM's proxynet address only
(`172.18.0.5`, or `172.18.0.0/16` if NPM's address cannot be pinned), never a network whose gateway can carry direct client traffic, and
NPM must restore the visitor's address from `CF-Connecting-IP` for the butler proxy host; both are in "Client IP and rate limits" above.

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

0. Pick a password of at most 72 bytes (UTF-8): bcrypt only reads the first 72, and `generate-password-hash.js` refuses anything longer.
1. Run `node scripts/generate-password-hash.js '<new password>'` (in the repo, or via
   `docker exec terrible-butler node scripts/generate-password-hash.js '<new password>'`
   against the live container) to print a bcrypt hash.
2. Set that hash as the `AUTH_PASSWORD_HASH` environment variable on the `terrible-butler`
   container in unRAID's Docker template (update `AUTH_USERNAME` too if it's changing).
3. Force update / restart the container for the new env vars to take effect. On that start
   the changed credential is detected and every JWT and device token is revoked (everyone
   logs in again). Optional env `APP_ORIGIN` (e.g. `https://butler.kiztigs.com`) pins the
   allowed Socket.IO origin; unset means the request's own origin (scheme+host+port; forwarded headers only from a `TRUST_PROXY` peer), so behind TLS set `APP_ORIGIN` or `TRUST_PROXY`.

## Rotating the JWT signing key (suspected key compromise)

Change `JWT_SECRET` (a new `openssl rand -hex 32`) and restart. Device tokens are opaque and not signed with the key, so on its own a key change would leave
remembered tablets logged in; instead the server records a keyed digest of the key next to the credential fingerprint and, when it differs at start, treats it
exactly like a password-hash change: the token epoch is bumped (every JWT stale) and every device token is revoked (`[Auth] JWT signing key changed since last
start` is logged). Signed `/media` URLs, derived from the same key, change too. The first start after the key digest was introduced (0.47) only records it:
the deploy itself revokes nothing. Neither the key nor the digest's input is stored or logged.

## Deploy and verify

1. Push to `main`.
2. Watch GitHub Actions: the `gate` job (full test suite, e2e, scanners; `.github/workflows/build.yml`) must pass before `build-and-push` runs
   and publishes `:latest`. `gh run list --workflow build.yml --limit 1`, then `gh run watch <id> --exit-status`.
3. On success, tell the user: **force update the `terrible-butler` container in unRAID's Docker
   tab.** The `butler-proxynet-autoconnect` User Script re-attaches `proxynet` automatically, so
   no 502 is expected.
4. For UI changes, tell the user to eyeball `https://butler.kiztigs.com` — the automated
   Playwright tests confirm behaviour, not visual correctness.

## Accepted by design (do not "fix")

Reviewed and decided by the owner; a scanner or reviewer flagging these has found a trade-off, not a defect.

- **Full request and response bodies are in the authenticated action log** (`logger.js`, `actionLogger`) — the owner asked for
  verbose logging (#14). Secrets are redacted recursively and long values truncated; only authenticated, non-throttled mutating calls
  are logged, and logins are body-less audit lines.
- **The account-wide login backoff can be held full by a distributed attacker**, which slows (or intermittently 429s) *new* logins.
  It never locks anyone out and never touches existing sessions or device tokens (`lib/login-backoff.js`). A hard lockout would let
  anyone who can reach the login lock the family out, which is strictly worse.
- **The text-hash invoice dedupe fallback cannot match a re-rendered PDF that has no invoice number** (`lib/invoice-dedupe.js`). With an
  invoice number the key is `retailer|no:<number>`; without one the key is a hash of the extracted text, so only an identical rendering
  matches.
- **The JWT lives in `localStorage`** (client). The XSS control is the strict CSP (constraint #9), not cookie flags; there are no cookies
  for the API, which is also why no CSRF middleware is needed.

## Scope notes

- Do not modify `.github/workflows/` unless the request is explicitly about CI.
- Do not modify the live container, live database, or live uploads directory.
