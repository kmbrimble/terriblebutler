# Handoff: security/auth (issues #49, #54, #56; routes/auth.js items of #61)

## Changelog-ready summary
- **Revocable sessions (#49).** Household JWTs now carry `ver` (token epoch) and `jti`, are HS256-only, and are rejected when `ver` is not the stored epoch. Lifetime stays 30 days.
- **Password rotation ends sessions (#49).** At startup a SHA-256 fingerprint of `AUTH_USERNAME` + `AUTH_PASSWORD_HASH` (the hash itself is never stored or logged) is compared with the stored one. A change bumps the epoch **and revokes every device token**. Changing the username alone counts. Rotating `JWT_SECRET` does not touch device tokens (the fingerprint is unkeyed on purpose).
- **Sign out everywhere (#49/#54).** `POST /api/auth/revoke-all` bumps the epoch and revokes all device tokens in one transaction, and drops every socket. New "Sign out everywhere" button in Manage Devices; the client ends its own session on success.
- **Device-token issuance (#54).** `POST /api/auth/device-token` needs a household JWT (device tokens get 403). The issuing JWT's `jti` is stored in `device_tokens.issued_by_jti`.
- **Sockets (#56).** Origin is enforced in the engine.io `allowRequest` hook (covers polling and WebSocket upgrades): `APP_ORIGIN` if set, otherwise the Origin host must equal the request Host; a present-but-mismatching or malformed Origin is refused. The `cors` option follows the same rule (no CORS headers unless `APP_ORIGIN` is set). Each socket records its credential; device revoke, revoke-all and epoch bumps disconnect matching sockets, after emitting `session_revoked` (the client then ends its session).
- **#61 (routes/auth.js only).** `device_label` capped at 100 characters (via `cleanText`); `bcrypt.compare` failure now logs server-side and answers a generic 500.
- **Schema:** see below.

## Follow-up (second pass): no loose ends
- **Sockets never outlive their credential.** `watchExpiry` (lib/realtime.js) schedules a disconnect at the credential's expiry and clears its timer on disconnect. JWT: the `exp` claim. Device token: `last_used_at` + 365 days, **re-read from the row when the timer fires** (the expiry slides with HTTP use, so a socket for an actively used device is kept; an open socket alone does not count as use, so an idle device's socket is dropped at its idle-expiry). Timers are capped at 24h per hop (setTimeout overflows above ~24.8 days, which a 30-day JWT exceeds) and are `unref`'d. On expiry the server emits `session_revoked` first so the client ends its session. Revocation events still disconnect immediately.
- **Fail fast on bad auth config.** `lib/config.js` now throws at load (process exits non-zero before touching the DB) unless: `AUTH_USERNAME` set; `AUTH_PASSWORD_HASH` matches the bcrypt format (`$2a/2b/2y$`, 2-digit cost, 53 chars); `JWT_SECRET` set and **at least 32 characters**. Messages name the variable only, never its value.
- **DEPLOY WARNING:** if the live container's `JWT_SECRET` is shorter than 32 characters, or `AUTH_PASSWORD_HASH` is not a bcrypt hash, the container will refuse to start after this deploy (deliberately at deploy time). Check both env values in the unRAID template before force-updating; if the secret is short, set a new one (`openssl rand -hex 32`), which logs JWT sessions out once, as the epoch change already does.
- Tests: `test/socket-expiry.test.js` (6; fake timers incl. a 30-day token, timer cleanup, sliding expiry, revoked, lookup failure), a real short-lived-JWT socket test in `test/realtime.test.js`, `credentialExpiry` tests in `test/auth-token-types.test.js`, `test/config-validation.test.js` (pure validator plus child-process boots that must exit non-zero without echoing the values).
- Decision kept: device-token holders can list/revoke devices and revoke-all.

## Schema change (migration #5, `PRAGMA user_version` 4 -> 5; idempotent)
- New table `auth_state(id INTEGER PRIMARY KEY CHECK (id = 1), token_epoch INTEGER NOT NULL DEFAULT 1, credential_fingerprint TEXT)`; one row, created on start.
- New column `device_tokens.issued_by_jti TEXT` (NULL for existing rows: provenance unknown).
- Both also in the base `CREATE TABLE` block for fresh installs. `CREATE TABLE IF NOT EXISTS` plus `hasColumn` guard. Tested on a populated legacy-shaped DB and for re-run safety (`test/auth-migration.test.js`). No existing rows are modified.

## Decisions
- **Missing `ver` is invalid.** Legacy JWTs (no `ver`) are rejected, since they cannot be revoked. Effect on first deploy below.
- **First start after upgrade only records the fingerprint** (no bump, no device revocation), so existing device tokens survive the deploy.
- **Rotation revokes device tokens** (rotation = lock everyone out), per the brief.
- **Who may do what.** Minting: household JWT only. Listing devices, revoking one device, and revoke-all: any valid credential. Reason: after "Remember this device" the client stores a device token, so requiring a JWT would stop a remembered tablet managing devices or cutting everything off from a lost phone. A stolen device token can therefore revoke other devices (availability, not escalation; recoverable by logging in). Revisit if that trade-off is unwanted.
- **Missing Origin header is allowed.** Browsers omit it on same-origin polling GETs and native clients (the planned React Native app) never send one; the token is still required. Present-but-wrong or malformed Origin is refused. This is "fail closed" for anything a cross-site page can do.
- **Same-origin means Origin host == Host header** (scheme ignored). Behind the proxy this assumes Host is passed through (NPM default `$host`). Not verifiable from the repo. If sockets stop connecting after deploy, set `APP_ORIGIN=https://butler.kiztigs.com` on the container.
- **bcrypt failure:** by code reading, Express 5 does forward the rejection, but the global handler (`server.js`) answers 400 with `err.message`, wrong for a misconfiguration and leaky. So it is caught explicitly: log + generic 500, tested. The global handler itself belongs to the pipeline agent (#61).
- Login-rate-limit-aware tests: only tests about the login route use `/api/auth/login`; others sign JWTs directly.

## Files
`lib/auth-state.js` (new), `lib/middleware.js`, `lib/realtime.js`, `lib/database.js`, `db-migrations.js`, `routes/auth.js`, `server.js`, client `api.ts` / `socket.ts` / `ManageDevicesModal.tsx` / `MenuDrawer.tsx` (+tests), `CLAUDE.md`, tests below. `package.json`: **dev dependency `socket.io-client` ^4.8.4** added (real-socket tests); expect a trivial lockfile merge at integration.

## Tests
- New: `test/session-revocation.test.js` (17), `test/realtime.test.js` (9), `test/auth-migration.test.js` (2); client `api.test.ts` + `socket.test.ts` additions; e2e "Sign out everywhere" (endpoint stubbed: really revoking would kill the shared e2e fixture token).
- Changed: `test/setup.js`, `test-e2e/auth-fixtures.cjs` (tokens now need `ver`/`jti`), `test/auth.test.js`, `test/auth-token-types.test.js` (`authenticateToken` now returns the credential or `null`), `test/module-seam.test.js` (+`POST /api/auth/revoke-all`, deliberate).
- Observed on the base before implementing: `realtime.test.js` failed per defect (cross-origin handshakes and upgrades got 200, revoked sockets stayed open, revoke-all 404). `session-revocation.test.js` failed as a unit (it imports the new `lib/auth-state.js`), so its individual cases were not seen failing one by one.
- Results at HEAD: `vitest run` 30 files all pass; client vitest 128/128; `npm --prefix client run build` OK; e2e (under the flock) 72/72.
- Note: `npm ci` for the root failed in this sandbox (Node 22 host, no prebuilt better-sqlite3); node_modules were copied from the deps-toolchain worktree.

## Deploy notes
- **Existing sessions on first deploy:** every household JWT stops working (no `ver`), so anyone logged in with a password session sees the login screen once. **Device tokens keep working** (not revoked on first start). Open sockets die with the container restart anyway.
- Schema migration runs automatically; take the pre-deploy snapshot per CLAUDE.md as for any schema change.
- Optional env `APP_ORIGIN`; see above.
- Do not rotate `AUTH_PASSWORD_HASH` at the same deploy as this upgrade: the first start only records the fingerprint, so that rotation would not revoke anything. Rotate on a later restart, or use "Sign out everywhere" after the first start.
- Rotating the password later (recovery section in CLAUDE.md) now logs everyone out, devices included.

## CLAUDE.md changes
Constraint #2 (epoch/jti, JWT-only minting), server layout (`auth-state.js`, realtime, `createAuth` signature), database notes (migration mechanism, `auth_state`, `issued_by_jti`), recovery step (rotation revokes everything, `APP_ORIGIN`).

## Review
`code-diff-reviewer`, score 11 (CALL band; mid-and-above: 3 Sonnet + 1 Mythos). Counsel (required by the skill in the CALL band) was **skipped as a deliberate deviation**, because the run was unattended; the owner may want it run before merge. Sonnet x3: NO FINDINGS (weak evidence). Mythos: two process findings, no code defects: (1) no CHANGELOG entry, deliberate (told not to edit it; this file is the changelog source); (2) #61 only partly addressed, by design (other items belong to the pipeline agent). No code changes resulted.

## Not done / flagged
- Device tokens minted before this change have unknown provenance (NULL `issued_by_jti`); any "child" tokens minted by device tokens in the past cannot be identified, but revoke-all kills them.
- Host-header pass-through at NPM/Cloudflare is assumed (unverifiable here).
