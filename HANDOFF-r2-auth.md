# HANDOFF — r2-auth (branch `security/r2-auth`, based on 1bb8eea / 0.41)

## Changelog-ready summary
- **Rate limits key IPv6 clients on their /64** (compressed forms, zone ids and IPv4-mapped addresses parsed and normalised; IPv4 unchanged). Rotating addresses inside an allocation no longer earns fresh buckets. Logs still record the full address.
- **Account-level login backoff** (`lib/login-backoff.js`). After 3 attempts, further attempts to `POST /api/auth/login` are spaced out account-wide (500 ms doubling to a 5 s cap), however many clients they come from; success resets it, 15 quiet minutes decay it. Delay, not lockout: the right password always works, after a wait of at most 15 s. If the wait queue is already 15 s deep the attempt gets `429` + `Retry-After`.
- **Rate-limit bucket eviction can no longer release a lockout.** At the 50,000-bucket cap the oldest bucket that is not over its limit is dropped; only if every bucket is locked is the soonest-expiring lockout dropped (memory stays bounded).
- **Socket.IO origin check compares scheme + host + port.** Without `APP_ORIGIN`, the expected origin is the socket's own scheme + `Host`, or `X-Forwarded-Proto`/`X-Forwarded-Host` when the direct peer is trusted per `TRUST_PROXY`. A missing Origin is still allowed (browsers omit it on same-origin polling GETs, native clients never send one; the token is still required).
- **Public health endpoints no longer disclose the version.** `/healthz` and unauthenticated `/api/health` return `{status:"ok"}`; `/api/health` with a valid bearer credential also returns `version`. (Neither the client nor e2e used the version; e2e readiness only needs status.)
- **Guard tests:** JWT algorithm pin (HS384/HS512/`alg:none`/no-`exp` rejected) and a route sweep generated from the live route table (every `/api/*` route but login/health is 401 unauthenticated and with a bad token; case / trailing slash / double slash / percent-encoded variants never serve data). Revoking a device and "Sign out everywhere" require the household password re-entered in the request (see Follow-up); that rule is pinned by `test/step-up-reauth.test.js`.
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
- Round 1 counsel attestation was incomplete (it recorded a hash of the diff, which was not what PAL sent; PAL embedded the full contents of lib/middleware.js, lib/login-backoff.js, lib/realtime.js, routes/auth.js, routes/health.js, server.js).
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

### Counsel — openai/gpt-5.6-terra (follow-up review, verbatim)
[🔴 CRITICAL] lib/middleware.js:80-89 – The authenticated action logger records raw request and response bodies, exposing household passwords and newly minted device tokens in logs. Excerpt: `request_body: req.body,` / `response_body: body,` `POST /api/auth/devices/:id/revoke` and `/api/auth/revoke-all` include `{ password }` (routes/auth.js:73-90), while `/api/auth/device-token` returns `{ token }` (routes/auth.js:101-104). Because these routes are mounted after `actionLogger` (server.js:106-112), both credentials are persisted wherever `logAction` writes or forwards logs. Anyone with log access can authenticate or perform destructive actions. → Fix: Redact sensitive fields before logging, without modifying the actual request/response objects. At minimum redact `password` and `token`, including recursively nested values if arbitrary JSON bodies are logged.

[🟠 HIGH] lib/middleware.js:129-136 – The rate-limit bucket eviction has an attacker-triggerable O(n) scan over up to 50,000 entries and can be driven into its worst case by locking all buckets. Excerpt: `for (const [key, bucket] of buckets) {` When a map reaches `MAX_RATE_LIMIT_BUCKETS` and all buckets exceed their limit, every new source address scans all 50,000 entries to find the earliest reset. For an internet-facing service, an attacker controlling many IPv6 /64 prefixes or distributed clients can repeatedly trigger this path, consuming the Node.js event loop and degrading all requests. The current fallback also deliberately evicts a locked bucket: `buckets.delete(soonest);` This weakens the stated guarantee that flooding cannot release active lockouts. → Fix: Avoid scanning the complete map on the request path. Track eviction candidates in an O(1) or O(log n) structure, or use a deliberately simple bounded insertion-order policy that does not inspect every bucket. If preserving locked buckets is required, maintain separate candidate tracking for unlocked buckets and the earliest locked reset rather than recalculating it on every insertion.

[🟡 MEDIUM] server.js:130-135 – The SPA fallback also handles unmatched `/api/*` requests, returning the React HTML document with HTTP 200 to authenticated callers instead of a JSON API 404. Excerpt: `app.get('/{*splat}', (req, res) => {` For example, an authenticated request to a misspelled API path falls through `requireAuth` and then receives `index.html`. This obscures routing errors, makes client error handling unreliable, and can cause API consumers to treat HTML as successful JSON data. → Fix: Register an explicit API 404 handler after all API routes and before the SPA fallback.

[🟡 MEDIUM] routes/auth.js:51-56 and routes/auth.js:101-104 – Authentication and device-token responses do not explicitly prohibit storage by browsers or intermediary reverse proxies. Excerpt: `res.json({ token });` The endpoints return bearer credentials. Although well-behaved caches generally do not cache POST responses without explicit freshness directives, auth-bearing responses should explicitly declare that they must not be stored, especially when the application is internet-facing behind a reverse proxy. → Fix: Set `Cache-Control: no-store` on responses that issue credentials.

[🟢 LOW] client/src/components/ManageDevicesModal.tsx:14-20 – The device-list request can complete after the modal has closed and call `setDevices` on an unmounted component. Excerpt: `getDevices().then(setDevices)` This is unlikely to cause a security issue, but it can produce stale updates during rapid modal open/close cycles and makes the request lifecycle less explicit. → Fix: Guard the completion with an effect-local cancellation flag.

Counsel's summary: "The major remaining concern is that this otherwise sound credential handling is defeated by raw action logging of passwords and issued device tokens. The rate-limit implementation also has a realistic worst-case availability risk for an internet-facing process." Top 3 priorities it listed: redact secrets from `actionLogger`; remove the O(50,000) eviction scan; add an explicit `/api` 404 handler.

(Code-fix snippets in the original are omitted here for length; the findings above are otherwise unedited.)

```
counsel seeding attestation
  model:            openai/gpt-5.6-terra
  issues_found:     [] (empty)
  conclusions sent: none
  excluded:         CHANGELOG.md, CLAUDE.md, commit messages
  material sent:    full contents of lib/middleware.js, routes/auth.js, server.js,
                    client/src/lib/api.ts, client/src/components/ManageDevicesModal.tsx,
                    client/src/components/PasswordConfirmDialog.tsx (PAL fully_embedded)
  prompt sha256:    5e064f371ba5232bfb86518efa436bcb92b00570c396a81235f8139af20415a2
```
