# HANDOFF — r2-auth (branch `security/r2-auth`, based on 1bb8eea / 0.41)

## Changelog-ready summary
- **Rate limits key IPv6 clients on their /64** (compressed forms, zone ids and IPv4-mapped addresses parsed and normalised; IPv4 unchanged). Rotating addresses inside an allocation no longer earns fresh buckets. Logs still record the full address.
- **Account-level login backoff** (`lib/login-backoff.js`). After 3 attempts, further attempts to `POST /api/auth/login` are spaced out account-wide (500 ms doubling to a 5 s cap), however many clients they come from; success resets it, 15 quiet minutes decay it. Delay, not lockout: the right password always works, after a wait of at most 15 s. If the wait queue is already 15 s deep the attempt gets `429` + `Retry-After`.
- **Rate-limit bucket eviction can no longer release a lockout.** At the 50,000-bucket cap the oldest bucket that is not over its limit is dropped; only if every bucket is locked is the soonest-expiring lockout dropped (memory stays bounded).
- **Socket.IO origin check compares scheme + host + port.** Without `APP_ORIGIN`, the expected origin is the socket's own scheme + `Host`, or `X-Forwarded-Proto`/`X-Forwarded-Host` when the direct peer is trusted per `TRUST_PROXY`. A missing Origin is still allowed (browsers omit it on same-origin polling GETs, native clients never send one; the token is still required).
- **Public health endpoints no longer disclose the version.** `/healthz` and unauthenticated `/api/health` return `{status:"ok"}`; `/api/health` with a valid bearer credential also returns `version`. (Neither the client nor e2e used the version; e2e readiness only needs status.)
- **Guard tests:** JWT algorithm pin (HS384/HS512/`alg:none` rejected), a route sweep generated from the live route table (every `/api/*` route but login/health is 401 unauthenticated and with a bad token; case / trailing slash / double slash / percent-encoded variants never serve data), and a test pinning the owner decision that device-token holders may list/revoke devices and sign out everywhere.
- Superseded: the "device tokens may revoke" behaviour above; see Follow-up.
- Household JWTs must now carry a finite `exp` (login always issues one); per-client 429s now send `Retry-After`.
- No schema change, no migration.

## Follow-up (owner corrections)
- **Revocation requires a fresh login (supersedes the earlier "device tokens may revoke" decision).** `POST /api/auth/devices/:id/revoke` and `POST /api/auth/revoke-all` need `{ "password": <household password> }` in the body, for JWTs and device tokens alike. Verified with bcrypt through the same account backoff as login, behind the shared `loginRateLimiter`, so a failed re-auth counts as a failed login. Missing/non-string/wrong password = **403** (not 401: the client treats 401 as an expired session); queue-full = 429 + `Retry-After`. The password is redacted from the action log (test). Listing devices is unchanged; minting is still household-JWT-only. Route table unchanged.
- **React client:** Manage Devices now opens `PasswordConfirmDialog` for both Revoke and Sign out everywhere (password held only in component state, cleared after each attempt and on close; wrong password shows the server's message in the dialog). `revokeDevice(id, password)` / `revokeAllSessions(password)` in `client/src/lib/api.ts`.
- **`RateLimit-Reset` is now seconds until the window resets** (was an epoch timestamp) on every limiter; 429s send the same value as `Retry-After`. The e2e helpers that read it (`test-e2e/rateLimitWait.js`, `v2-item-detail.spec.js`) were updated; any other consumer of the old epoch value must change too.
- **Strict `Authorization` parsing:** one `parseBearerToken` in `lib/middleware.js` (`Bearer`, case-insensitive, one or more spaces, a single RFC 7235 token68, nothing else) used by `requireAuth` and `/api/health`.

## Decisions
- Backoff is **in memory** (resets on restart) because migrations are out of scope; the per-client limiter and bcrypt remain the primary defence. Residual trade-off is documented in `lib/login-backoff.js`: an attacker who keeps the wait queue full can make login slow or intermittently 429; existing sessions/device tokens are unaffected. A hard lockout would be strictly worse.
- Version stays reachable via an authenticated `/api/health`, so the route table is unchanged (`module-seam` snapshot passes).

## Deploy notes
- **Socket.IO behind TLS needs `TRUST_PROXY` (or `APP_ORIGIN`).** Previously only the host was compared; now the scheme is too. With neither set, a browser on `https://butler.kiztigs.com` talking to the plain-http Node port would be refused. The recommended `TRUST_PROXY=172.17.0.0/16,172.18.0.0/16` (CLAUDE.md) plus NPM's default `X-Forwarded-Proto`/`X-Forwarded-Host` headers is sufficient; alternatively set `APP_ORIGIN=https://butler.kiztigs.com`. Verify the live template has one before releasing, then check the app still shows live updates.
- **Prefer `APP_ORIGIN=https://butler.kiztigs.com`**: it does not depend on NPM emitting the right `X-Forwarded-Proto`, which cannot be verified from the repo.
- Anything polling `/healthz` or `/api/health` for the version will now see none.

## Review (code-diff-reviewer, range 1bb8eea..HEAD)
- Score 10, CALL band. 3 Sonnet passes (first attempt hit the session limit and was re-run clean): NO FINDINGS. 1 Mythos pass: one single-pass finding, the Socket.IO scheme deploy dependency (UNVERIFIABLE FROM THIS REPO; covered in Deploy notes above). Counsel (gpt-5.6-terra) raised 6:
  - JWT without `exp` accepted: **fixed** (+ test).
  - First post-free login attempt not delayed: **fixed** (+ test). Real off-by-one.
  - Device token written to action log: **false positive**, `logger.js` `SENSITIVE_KEY` redacts `token` (line 21).
  - `loginAuditLogger` finish handler throwing: **false positive**, `logAction` catches internally (`logger.js:133-143`).
  - `RateLimit-Reset` is an absolute epoch, not seconds: pre-existing, **deferred** (changing the header semantics affects clients; `Retry-After` now added instead).
  - Loose `Authorization` split: pre-existing, **deferred**; parsing is now one shared `credentialFromRequest`.

## Follow-up flags
- The per-client login limit (5/15 min) is shared by login and by revoke/sign-out attempts, as specified. Logging in and then revoking several devices in one sitting can reach it; the user sees a 429 message and waits.
- The test suite sets `LOGIN_RATE_LIMIT_MAX=1000` in `test/setup.js`; tests of the limiter load a fresh app with the production 5.
- The sibling r2-client branch also edits client code (`ManageDevicesModal.tsx`, `api.ts`); expect to reconcile on integration.

## Review of the follow-up (range fe8ac77..HEAD)
- Score 11, CALL band. 3 Sonnet + 1 Mythos passes: all NO FINDINGS (a known failure mode, so not read as clean). Counsel (gpt-5.6-terra) raised 5:
  - Password/token written to the action log (rated critical): **false positive**. `logger.js` redacts keys matching `pass|token|...` before writing, and `test/step-up-reauth.test.js` proves the re-entered password never reaches the log file. Counsel saw `middleware.js` but not `logger.js`.
  - `Cache-Control: no-store` on login and device-token responses: **fixed** (+ test).
  - O(n) eviction scan when all 50,000 buckets are locked: **accepted**, already marked with a `ponytail:` comment. Reaching it needs more than 5 attempts from each of 50,000 distinct /64s; the account backoff still protects the password in that case.
  - Authenticated unknown `/api/*` GETs return the SPA HTML with 200 instead of a JSON 404: pre-existing, **deferred** (server.js route order; unauthenticated callers still get 401).
  - `setDevices` after unmount in `ManageDevicesModal`: low, **deferred** (r2-client edits that file; no warning in React 19).
