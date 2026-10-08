# HANDOFF — r2-auth (branch `security/r2-auth`, based on 1bb8eea / 0.41)

## Changelog-ready summary
- **Rate limits key IPv6 clients on their /64** (compressed forms, zone ids and IPv4-mapped addresses parsed and normalised; IPv4 unchanged). Rotating addresses inside an allocation no longer earns fresh buckets. Logs still record the full address.
- **Account-level login backoff** (`lib/login-backoff.js`). After 3 attempts, further attempts to `POST /api/auth/login` are spaced out account-wide (500 ms doubling to a 5 s cap), however many clients they come from; success resets it, 15 quiet minutes decay it. Delay, not lockout: the right password always works, after a wait of at most 15 s. If the wait queue is already 15 s deep the attempt gets `429` + `Retry-After`.
- **Rate-limit bucket eviction can no longer release a lockout.** At the 50,000-bucket cap the oldest bucket that is not over its limit is dropped; only if every bucket is locked is the soonest-expiring lockout dropped (memory stays bounded).
- **Socket.IO origin check compares scheme + host + port.** Without `APP_ORIGIN`, the expected origin is the socket's own scheme + `Host`, or `X-Forwarded-Proto`/`X-Forwarded-Host` when the direct peer is trusted per `TRUST_PROXY`. A missing Origin is still allowed (browsers omit it on same-origin polling GETs, native clients never send one; the token is still required).
- **Public health endpoints no longer disclose the version.** `/healthz` and unauthenticated `/api/health` return `{status:"ok"}`; `/api/health` with a valid bearer credential also returns `version`. (Neither the client nor e2e used the version; e2e readiness only needs status.)
- **Guard tests:** JWT algorithm pin (HS384/HS512/`alg:none` rejected), a route sweep generated from the live route table (every `/api/*` route but login/health is 401 unauthenticated and with a bad token; case / trailing slash / double slash / percent-encoded variants never serve data), and a test pinning the owner decision that device-token holders may list/revoke devices and sign out everywhere.
- No schema change, no migration.

## Decisions
- Backoff is **in memory** (resets on restart) because migrations are out of scope; the per-client limiter and bcrypt remain the primary defence. Residual trade-off is documented in `lib/login-backoff.js`: an attacker who keeps the wait queue full can make login slow or intermittently 429; existing sessions/device tokens are unaffected. A hard lockout would be strictly worse.
- Version stays reachable via an authenticated `/api/health`, so the route table is unchanged (`module-seam` snapshot passes).

## Deploy notes
- **Socket.IO behind TLS needs `TRUST_PROXY` (or `APP_ORIGIN`).** Previously only the host was compared; now the scheme is too. With neither set, a browser on `https://butler.kiztigs.com` talking to the plain-http Node port would be refused. The recommended `TRUST_PROXY=172.17.0.0/16,172.18.0.0/16` (CLAUDE.md) plus NPM's default `X-Forwarded-Proto`/`X-Forwarded-Host` headers is sufficient; alternatively set `APP_ORIGIN=https://butler.kiztigs.com`. Verify the live template has one before releasing, then check the app still shows live updates.
- Anything polling `/healthz` or `/api/health` for the version will now see none.
