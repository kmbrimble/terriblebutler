# HANDOFF — r2-ops (branch security/r2-ops, base 1bb8eea)

## Changelog-ready text
- **Container hardening:** the entrypoint now validates `DB_PATH`, `UPLOADS_DIR` and `LOG_DIR` before chowning as root (absolute, normalised, strictly inside `/app`, not application code, mutually disjoint, symlinks may not escape) and exits with a clear message otherwise. `lib/config.js` applies the same rules.
- **Image contents:** the runtime stage copies an explicit allow-list instead of `COPY . .` (client source no longer in the image); `.dockerignore` excludes `.env*`, `*.pem`, `*.key`, `.npmrc` and similar.
- **PDF parsing:** text extraction runs in a worker thread with a hard deadline (20 s) and heap ceiling (256 MB); the page bound is pinned by a test.
- **Anthropic calls:** explicit per-attempt timeout (45 s) and 1 retry (SDK defaults were 10 min / 2).
- **Backups:** files are named `inventory-<UTC timestamp>.db`; same-day backups no longer overwrite. Old date-only names are still pruned (14 days).
- **Action log:** the stdout copy is a bounded asynchronous stream (same overflow semantics as the file) rather than a synchronous `console.log`.
- **CLAUDE.md:** strict CSP promoted to non-negotiable #9.
- Tests: entrypoint (stubbed `sh` run, shell/JS parity table), build-context/UPLOADS_DIR guards, PDF worker, SDK limits, backups, logger. New `scripts/docker-smoke.sh`.

## Deploy notes — new env vars (all optional)
| Var | Default | Meaning |
|---|---|---|
| `WRITABLE_ROOT` | `/app` (set by Dockerfile) | enables containment checks in `lib/config.js` |
| `PDF_PARSE_TIMEOUT_MS` | 20000 | PDF extraction deadline |
| `PDF_WORKER_MEMORY_MB` | 256 | PDF worker heap ceiling |
| `ANTHROPIC_TIMEOUT_MS` | 45000 | per attempt |
| `ANTHROPIC_MAX_RETRIES` | 1 | 0–5 |
| `ACTION_LOG_STDOUT` | on | `0` disables stdout copy |

Behaviour change to check in the unRAID template: `DB_PATH`/`UPLOADS_DIR`/`LOG_DIR` outside `/app`, or containing characters other than letters, digits, `.`, `_`, `-`, now stop the container. The documented live mounts (`/app/data`, `/app/public/uploads`) are fine. No migrations. CHANGELOG/version untouched.

## Decisions
- Stdout log copy kept (LOG_DIR is not a mounted volume, so `docker logs` is the durable copy) rather than dropped.
- Entrypoint `APP_ROOT=/app` is hardcoded; tests rewrite that one line to a temp root.
- Overlap check in config only applies when `WRITABLE_ROOT` is set (tests/local runs share one temp dir).
- Invoice parse timeout surfaces via the existing 500 + correlation_id path (routes/invoices.js is r2-invoices' file; not edited).
- Dockerfile allow-list: a new top-level server module must be added to the COPY line (guard test fails otherwise). Integration: r2-auth/r2-invoices adding modules outside `lib/ routes/ parsers/ scripts/` must extend it.

## Smoke
`scripts/docker-smoke.sh [tag]` (build, health, uid/no-new-privs/PID 1, ownership, no client source, bad DB_PATH refused, SIGTERM exit 0). Run twice on `smoketest-butler:r2ops`: PASS. All smoketest objects removed.
