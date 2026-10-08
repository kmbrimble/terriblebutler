# HANDOFF — r2-ops (branch security/r2-ops, base 1bb8eea)

## Changelog-ready text
- **Container hardening:** the entrypoint now validates `DB_PATH`, `UPLOADS_DIR` and `LOG_DIR` before chowning as root (absolute, normalised, strictly inside `/app`, not application code, mutually disjoint, symlinks may not escape; logs may sit inside the data dir) and exits with a clear message otherwise. `lib/config.js` applies the same rules.
- **Image contents:** the runtime stage copies an explicit allow-list instead of `COPY . .` (client source no longer in the image); `.dockerignore` excludes `.env*`, `*.pem`, `*.key`, `.npmrc` and similar.
- **PDF parsing:** text extraction runs in a worker thread with a hard deadline (20 s) and heap ceiling (256 MB); the page bound is pinned by a test.
- **Anthropic calls:** explicit per-attempt timeout (45 s) and 1 retry (SDK defaults were 10 min / 2).
- **Backups:** files are named `inventory-<UTC timestamp>.db`; same-day backups no longer overwrite. Old date-only names are still pruned (14 days).
- **Action log:** the stdout copy now has the same 1 MB bound and `log_overflow` record as the file copy, and survives a closed stdout (EPIPE). (The review showed `console.log` to a pipe is already non-blocking on Linux, so the gain is the bound/overflow/EPIPE behaviour, not unblocking.) `flush()` waits at most 1.5 s for a stalled stdout so shutdown is never held up. Side effect: an `'error'` listener on `process.stdout` now swallows EPIPE for every stdout writer in the process.
- **Review fixes:** `UPLOAD_TMP_DIR` validated when set; PDF env limits must be safe integers within bounds; `sanitize` now redacts/caps string bodies; `matchLinesWithLLM` output budget scales with line count (a 250-line import exceeded the fixed 2048 tokens); nightly backup reschedules only after the previous run settles.
- **CLAUDE.md:** strict CSP promoted to non-negotiable #9.
- Tests: entrypoint (stubbed `sh` run, shell/JS parity table), build-context/UPLOADS_DIR guards, PDF worker, SDK limits, backups, logger. New `scripts/docker-smoke.sh`.

## Deploy notes — new env vars (all optional)
| Var | Default | Meaning |
|---|---|---|
| `WRITABLE_ROOT` | `/app` (set by Dockerfile) | enables containment checks in `lib/config.js` |
| `PDF_PARSE_TIMEOUT_MS` | 20000 | PDF extraction deadline (max 600000) |
| `PDF_WORKER_MEMORY_MB` | 256 | PDF worker heap ceiling (max 4096) |
| `ANTHROPIC_TIMEOUT_MS` | 45000 | per attempt |
| `ANTHROPIC_MAX_RETRIES` | 1 | 0–5 |
| `ACTION_LOG_STDOUT` | on | `0` disables stdout copy |

`UPLOAD_TMP_DIR` (existing var): if set, must be a normalised absolute path and not overlap data directories, else startup is refused.

Behaviour change to check in the unRAID template: `DB_PATH`/`UPLOADS_DIR`/`LOG_DIR` outside `/app`, or containing characters other than letters, digits, `.`, `_`, `-`, now stop the container. The documented live mounts (`/app/data`, `/app/public/uploads`) are fine. No migrations. CHANGELOG/version untouched.

## Decisions
- Stdout log copy kept rather than dropped (`docker logs` remains a second copy).
- Entrypoint `APP_ROOT=/app` is hardcoded; tests rewrite that one line to a temp root.
- Overlap check in config only applies when `WRITABLE_ROOT` is set (tests/local runs share one temp dir).
- Invoice parse timeout surfaces via the existing 500 + correlation_id path (routes/invoices.js is r2-invoices' file; not edited).
- Dockerfile allow-list: a new top-level server module must be added to the COPY line (guard test fails otherwise). Integration: r2-auth/r2-invoices adding modules outside `lib/ routes/ parsers/ scripts/` must extend it.

## Smoke
`scripts/docker-smoke.sh [tag]` (build, health, uid/no-new-privs/PID 1, ownership, no client source, bad DB_PATH refused, SIGTERM exit 0). Now also checks that a mutating call appears as an `[Action]` line in `docker logs`. Requests run inside the container (an earlier host-port curl proved unreliable on the shared daemon). Final run on the last commit: PASS. All smoketest objects removed.

## Review (code-diff-reviewer) — range 1bb8eea..HEAD (as of the commit before the review fixes)
```
r2-ops  (with --infra: exposure 2, authority 3, data 2, reversibility 1, test gap 1, pattern 0, modules 1, infra -2)
  FINAL 8  band: MID
r2-ops (no infra suppressor: root entrypoint is the change)  -> base 10, FINAL 10, band: CALL — call counsel
```
The suppressor was dropped because the root-running entrypoint *is* the repo change; no out-of-repo infra is being discounted. Passes: 3 Sonnet + 1 Mythos, none failed (Sonnet pass 3: NO FINDINGS, a known failure mode). Union: 3 raw -> 1 finding, cost US$3.44. UNVERIFIABLE FROM THIS REPO: none.
- Finding (A, 3/4, conf 85, Sonnet+Mythos): second fs stream on fd 1 fails with EAGAIN on a full pipe and then disables the stdout copy. **Fixed** (uses process.stdout). The real-pipe regression test did NOT fail against the old code in this environment; it is a no-crash guard, and the docker smoke is the evidence.
- Counsel (openai/gpt-5.6-terra) was called (CALL band). Decisions: UPLOAD_TMP_DIR validation **fixed**; PDF env bounds **fixed**; primitive log bodies **fixed**; matchLinesWithLLM 2048-token budget **fixed** (scales with lines); backup reschedule overlap **fixed**; scratch-dir symlink/mode check **not acted on** (default is the container's own /tmp, attacker would need to be inside already); prompt-injection delimiting **not acted on** (pre-existing, out of scope, damage bounded by strict schema + id validation); bounding the `existingItems` list sent to matching **left** (r2-invoices' area).
- The fix commits after the review (and these last changes) were not re-reviewed.

## Round 2 additions
- **Action logs persist.** `LOG_DIR` now defaults to `<dir of DB_PATH>/logs` (`/app/data/logs` in the container), on the already-mounted data volume beside `backups/`; the entrypoint's recursive chown of the data directory covers it, and the 30-day pruning runs there as before. `LOG_DIR` may sit inside the data directory but not be or contain it (entrypoint and `lib/config.js` agree, parity-tested). **Deploy effect:** no template change; after the update, new logs appear on the host at `/mnt/user/appdata/butler/data/logs/`. Logs in the old `/app/logs` (inside the container layer) are not migrated. The stdout copy is kept. Smoke checks the log file lands on the data volume.
- **Scratch dir hardening.** At startup `UPLOAD_TMP_DIR` is created 0700 if absent; if present it must be a real directory (not a symlink), owned by the runtime user, mode 0700, or the process refuses to start. **Deploy effect:** a pre-existing `/tmp/butler-upload-tmp` with another mode or owner (only possible if the container's /tmp persisted) stops startup with a clear message.
- **Prompt delimiting.** `buildPrompt` in `lib/llm-client.js`: instructions first, a data-not-instructions notice, then each piece of untrusted text in `<<<BEGIN DATA name id=…>>>` blocks with a per-request random id (so text cannot forge an end marker); lists are JSON. Used for classification, matching, label scan (also flags the image as data) and invoice parse. **Integration note:** `routes/invoices.js` (invoice parse call) and `routes/uploads.js` changed at the prompt-building lines only; r2-invoices touching the same lines will conflict trivially — keep the `buildPrompt` calls.

## Review round 2 — full range 1bb8eea..HEAD (covers the post-review commits)
Score (no infra suppressor, as before): exposure 2, authority 3, data 2, reversibility 1, test gap 1, pattern 0, modules 1, 526 non-test lines -> base 10, +1 length, **FINAL 11, CALL**. Passes: 3 Sonnet + 1 Mythos, none failed, **all four returned NO FINDINGS** (flagged by the tooling as a known failure mode, not evidence of clean code; the first-round Mythos pass did find a real bug), union 0, cost US$3.72. Counsel (gpt-5.6-terra) was then called, seeded with code only. Decisions on its findings:
- Backup rescheduled a fixed 24 h after completion (DST drift): **fixed** (next local hour), tested.
- Numeric env limits (`INVOICE_IMPORT_MAX_LINES`, rate-limit maxima) accepted negative/unsafe values: **fixed** (bounded safe integers, fall back to defaults), tested.
- `/app/public` itself accepted as a writable dir: **fixed** (exact-match refusal in entrypoint and config; `/app/public/uploads` still allowed), parity-tested.
- **Not mine, left for r2-invoices / r2-auth (flagged for integration):** `/api/invoices/commit` `location_id` uses `parseInt` without `validForeignId`; no retention/cleanup for abandoned `invoice_imports` staging rows; `/api/invoices/parse` has no item-count bound and a fixed 4096-token budget; bcrypt-hash regex accepts cost `00`–`99` (`validateAuthEnv`, r2-auth). I did not edit those areas.
- Final suites on HEAD: backend 544 passed, client 130, client build clean, e2e 57, docker smoke PASS (health, uid/no-new-privs/PID 1, ownership, action log in `docker logs`, bad `DB_PATH` refused, graceful stop, log file persisted on the data volume). No smoketest objects remain.
