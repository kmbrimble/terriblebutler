# Handoff: security/pipeline (issues #52, #53, #55, #61 minus the two routes/auth.js items)

## Changelog-ready summary
- **Action log (#52):** the logger is mounted after the rate limiters and `requireAuth`, so unauthenticated or throttled requests never have a body logged. Logins are a separate body-less audit line (`event: "login"`, outcome `success|failure|rate_limited|rejected`, status, client IP; username only on success). Redaction is recursive and key-pattern based (password, token, secret, authorization, cookie, key, hash, credential, jwt, bearer, session); bodies over 4096 JSON chars become `{truncated, original_chars, preview}`. Writes use one append stream per week with a 1 MiB buffer cap; past it entries are dropped and counted, and a `log_overflow` record notes the loss. Pruning (30 days) now runs when a weekly file is opened rather than on every write; unlink failures are logged. Shutdown flushes the stream.
- **Client IP (#53):** new `TRUST_PROXY` env (validated at startup, logged at listen). Unset = trust nothing (previous behaviour). Hop count, or comma-separated IPs/CIDRs/`loopback|linklocal|uniquelocal`. `true`, `*`, `/0` ranges and malformed entries abort startup. Rate-limit keys use the resolved IP with `::ffff:` folded.
- **Invoice import (#55):** `POST /api/invoices/import` shares the LLM limiter (10/min; method+path gated so GET/PATCH/DELETE/commit under the prefix are unaffected). `INVOICE_IMPORT_MAX_LINES` (default 250) rejects larger invoices with 422 before anything is staged. Classification is now batched (25 lines per call, 3 calls in flight) via `classifyLinesWithLLM`; the per-line `classifyLineWithLLM` is removed. Classification or matching failures are logged at error level and returned as `warnings: string[]` on the import response.
- **Hardening (#61):** every 500 that echoed `err.message` (categories, locations, items ignore-grocery, four invoice handlers, global handler) now returns `"<what failed>. Reference: <8 hex>"` plus `correlation_id`; the full error is logged as `[Error <uuid>]`. Deliberate 4xx messages are kept (multer, unsupported upload type, malformed JSON -> 400, too large -> 413). Category/location names: string, trimmed, 1-100 chars, on create and update (`cleanName` over `cleanText`); duplicates now 409 instead of a 500 with the SQLite text. Pruning unlink failures logged in `logger.js` and `backup.js`.
- **Schema:** none.

## Decisions
- **Batching over a concurrency pool of per-line calls:** the category/location lists are sent once per chunk instead of once per line (cheaper, and shrinks the prompt-inflation surface from #61), and call count is ceil(N/25). The pool (3) still bounds in-flight calls. Same pattern as `matchLinesWithLLM`.
- **Line cap 250:** real Coles/Woolworths orders in the fixtures are 30-32 lines; 250 leaves large-order headroom while bounding rows and LLM work. Configurable.
- **Login audit hooked in `server.js`**, not `routes/auth.js` (auth agent's file).
- **Address list preferred over hop count** (see below). The parser is strict because Express would accept shorthand like `1` as an address.
- **Stdout copy of the action log stays synchronous** (`console.log`); it is bounded by the 4 KiB body cap and now only reachable by authenticated, throttled callers. The file path is the unbounded-risk one and is fully async.
- Name limit 100 chars (items use 500; names are interpolated into every LLM prompt).
- Test infra: `LLM_RATE_LIMIT_MAX` defaults to 1000 in `test/setup.js` and is set in `test-e2e/global-setup.mjs`, because imports now consume the LLM budget. `test/fresh-app.js` reloads the CommonJS app for per-test env (native `require` cache is not reset by `vi.resetModules()`).

## TRUST_PROXY recommendation
**`TRUST_PROXY=172.17.0.0/16,172.18.0.0/16`** (docker0 and `proxynet` subnets), plus `192.168.0.10` only if the verification step below shows it.

Evidence (read-only `docker inspect` / `docker network inspect` / NPM config reads; nothing changed, no traffic sent):
- `terrible-butler`: networks `bridge` + `proxynet` (requested static 172.18.0.3); `2626/tcp` published on all interfaces. NOTE: it is in state `created` (never started, no start time) with `NODE_VERSION=20.20.2` in its env, i.e. the old image; Immich currently holds 172.18.0.3 on proxynet, so the static request may collide when the new container first starts.
- NPM (`Nginx-Proxy-Manager-Official`): `proxynet` 172.18.0.5 (dynamic, no static IPAM) + `br0` 192.168.0.23 (ipvlan, 192.168.0.0/22); no published ports. Proxy host 15 (`butler.kiztigs.com`) forwards to `terrible-butler:2626` over proxynet and sets `X-Forwarded-For $proxy_add_x_forwarded_for` and `X-Real-IP $remote_addr`.
- `cloudflared`: default `bridge`, 172.17.0.7, remote-managed tunnel (token), so its ingress target is not inspectable from here.
- NPM `nginx.conf`: `set_real_ip_from` 10/8, 172.16/12, 192.168/16 plus ~265 CDN ranges, `real_ip_header X-Real-IP`.

Reasoning:
- App peer on both paths is NPM (172.18.0.5). **LAN:** browser -> NPM -> app; XFF = `<lan client>`. **Cloudflare:** browser -> Cloudflare -> cloudflared -> NPM -> app; XFF = `<client>, <cloudflared as NPM sees it>`, so one extra trusted hop must be skipped. A hop count cannot serve both (1 vs 2 hops), and a hop count also trusts the direct peer, so anyone reaching the published port 2626 could spoof XFF. An address list only honours XFF from listed peers: a direct LAN caller's peer is their real address (untrusted), so their XFF is ignored.
- Both /16s are used rather than /32s because NPM and cloudflared addresses are dynamic. Do **not** use `uniquelocal` or 192.168.0.0/16: that is the LAN itself.
- Fail-safe: a wrong list only collapses clients into shared buckets (today's behaviour), it does not open a bypass.

Owner steps (unRAID template; I changed nothing): add variable `TRUST_PROXY` = the value above. After the deploy, log in once from the LAN and once through `butler.kiztigs.com`, and check `docker logs terrible-butler` for the `"event":"login"` lines: `ip` must be each device's real address. If the Cloudflare login shows a private address, that is the cloudflared hop as NPM sees it (possibly the host, `192.168.0.10`): append it to `TRUST_PROXY`.

Out-of-repo caveat (unverified, flagged for the owner, not testable from this repo): NPM trusts private sources for `real_ip_header X-Real-IP`, so a client-supplied `X-Real-IP` arriving via the tunnel/LAN may be adopted by NPM as `$remote_addr` and appended to XFF. If confirmed it lets a caller choose the address the app keys on. Mitigation is on the NPM side (e.g. take the client address from `CF-Connecting-IP` on this host, or strip inbound `X-Real-IP`).

## Review
`code-diff-reviewer` on `48b87ad..HEAD` (before the final handler fix): 3 Sonnet + 1 Mythos + counsel; union 3 findings from 4 raw, US$3.31.

```
security/pipeline 48b87ad..HEAD
  exposure               3
  authority              2
  data integrity         1
  reversibility          1
  test-coverage gap      1
  pattern divergence     1
  module spread          1
  ------------------------------
  base                   10
  length modifier        +1  [500 lines]
  FINAL                  11   band: CALL — call counsel
```
- pass-1 (Sonnet) returned NO FINDINGS (a known failure mode, not evidence of cleanliness); pass-2, pass-3 and the Mythos pass produced the findings below.
- Fixed: malformed `%`-escape in a path param (agreement 2/4) and malformed multipart bodies (1/4) were turned into 500s by the new global handler (previously 400); now 400, with tests. The busboy message match carries a `ponytail:` note (upgrade path: tag errors in a wrapper around the multer instances).
- Open: `warnings` on the import response has no client consumer (`InvoiceImportState` needs `warnings?: string[]` and a toast in `InvoiceImportModal`): frontend scope.
- Counsel (`openai/gpt-5.6-terra`), all outside this diff or pre-existing: upload stored extension taken from `originalname` (uploads agent); `/api/invoices/commit` lacks item validation; no cap on PDF-extracted text sent to the LLM; boolean coercion in `ignore-grocery`/`open`; location delete drops `is_open`; nightly backup DST drift; unbounded rate-limit bucket map; import row inserted before LLM work (orphan row if a later step throws). Left for follow-up issues.
- Not run: advisor-style adjudication of counsel beyond the above triage.

```
counsel seeding attestation
  model:            openai/gpt-5.6-terra
  issues_found:     [] (empty)
  conclusions sent: none
  excluded:         CHANGELOG.md, CLAUDE.md, commit messages
  material sent:    server.js, logger.js, backup.js, lib/{config,middleware,llm-client,domain-helpers,shutdown}.js, routes/{invoices,categories,locations,items}.js (current files; the diff itself was not sent, only the review-range statement)
  prompt sha256:    4ac5b1d95e4989301af147d0ef12568446cef33cbbf9ed28935726c121fd2031
```

## Left for integration / other agents
- `routes/invoices.js` `fs.unlink(..., () => {})` (parse and import `finally`) and `routes/uploads.js` unlink: untouched by design (uploads agent). If they do not log failures, #61's third bullet remains open there.
- `routes/auth.js` `device_label` cap and `bcrypt.compare` catch: auth agent.
- Likely merge conflicts: `routes/invoices.js` (500 handlers and import fan-out vs the PDF page bound), `lib/middleware.js` (`fileFilterFor` now tags its error `status: 400, expose: true`; the global handler relies on it), `server.js`, `CLAUDE.md` (new "Client IP and rate limits" section).
- Environment note: this host's default node is v22 and cannot build better-sqlite3 13; `node_modules` was copied from the sibling worktree (same lockfile). Not a repo change.

## Deploy notes
No schema change, no pre-change backup needed for this branch alone. Optional env: `TRUST_PROXY`, `INVOICE_IMPORT_MAX_LINES`. Behaviour changes to eyeball: category/location names over 100 chars or non-text are now rejected on edit; the action log no longer contains login bodies or any unauthenticated request.

## Verification
`npm test`: 31 server files / 358 tests and 17 client files / 125 tests pass; client `npm run build` passes; `flock /tmp/butler-e2e.lock npm run test:e2e`: 71/71. Regression tests were run red first for `trust-proxy`, `action-logging`, `error-hardening`; `invoice-import-limits` was written after the implementation and run against a throwaway worktree at `48b87ad` afterwards (6/6 fail there). (New files: `trust-proxy`, `invoice-import-limits`, `error-hardening`; extended: `action-logging`, `logger`, `backup`, `llm-anthropic`.)
