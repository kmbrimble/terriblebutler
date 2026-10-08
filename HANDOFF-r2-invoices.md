# HANDOFF — R2-INVOICES (`security/r2-invoices`, based on main @ 1bb8eea)

No CHANGELOG or version edits (integration owns them). CLAUDE.md database notes updated (migration 6, `ValidationError`).

## Schema change — migration 6 (`user_version` 5 → 6)

Idempotent; every step guarded by `hasTable`/`hasColumn`/`IF NOT EXISTS`. Also in `lib/database.js` base schema for fresh installs.

1. `ALTER TABLE invoice_imports ADD COLUMN dedupe_key TEXT` + `CREATE UNIQUE INDEX idx_invoice_imports_dedupe_key ON invoice_imports(dedupe_key)`.
   Backfill: rows with an invoice number get `retailer|no:<lower-cased, space-collapsed number>`. Where several existing rows share a key, the committed row (else oldest) keeps it and the others stay NULL (NULLs never collide), so no row is deleted and the index always builds. Rows with no number stay NULL (the content-hash fallback applies to future imports).
   The index is created in the migration and again, `IF NOT EXISTS`, after `runMigrations` in `lib/database.js` (fresh DBs skip migrations, and the base `CREATE TABLE` block cannot index a column an existing DB does not have yet).
2. `ALTER TABLE invoice_import_lines ADD COLUMN category_cleared INTEGER NOT NULL DEFAULT 0` and `location_cleared` likewise (existing rows = 0 = old behaviour).
3. Triggers `item_locations_quantity_nonneg_insert` / `_update` (`BEFORE INSERT`, `BEFORE UPDATE OF quantity`, `WHEN NEW.quantity < 0` → `RAISE(ABORT)`). A table-level CHECK would need a full table rebuild of a populated table; triggers give the same guarantee with no rebuild. They also run in the base schema. Existing negative rows (if any) are not modified and can still have `is_open` changed or be corrected upwards. **Not verified against the live DB** (never touched) — pre-change backup not needed for this branch's testing, but the integrator should take the standard snapshot before deploy because this is a schema change.

## Per item

- **#42** `location_id` on `/api/invoices/commit` now via `validForeignId` (also made strict: `1abc`, `1.9`, `1e2`, `0`, `-1` are rejected instead of coerced to another row). Shared `QUANTITY_MAX = 1,000,000` applied to invoice commit, item create, quantity/deduct/move amounts and import-line `qty_confirmed`. DB-level guard = triggers above. Tests: `test/invoice-integrity.test.js`, `test/invoice-schema-migration.test.js`.
- **#43** Re-verified: header and lines are written in one `db.transaction` after all async work. Added a test that fails the *third* line insert and asserts neither header nor any line remains. Ready to close.
- **#44** `lib/invoice-dedupe.js`: key = `retailer|no:<number>` else `retailer|sha256:<whitespace-normalised extracted text>`. Pre-check before any LLM spend; the UNIQUE index is the backstop (unique-violation caught → same 409, covers two uploads racing). 409 body: `{code:'duplicate_invoice', error, existing_import:{id,status,...}}`. Client shows a banner; "Open the existing import" only while it is not committed. Cancelling an in-progress import frees the key; a committed import keeps it (re-import of a committed invoice is refused permanently — intended). `dedupe_key` is returned in import payloads (not sensitive).
- **#46** PATCHing `final_category_id`/`final_location_id` to null sets `*_cleared=1`; patching a value sets 0. Commit: `cleared ? null : final ?? suggested`. Client `resolveLineCategoryValue`/`Location` and optimistic `applyLinePatch` mirror it.
- **#47** Import with zero parsed lines → 422 before staging; `/import/:id/commit` with no lines → 400; `/api/invoices/commit` with `[]` → 400. Client: commit disabled when there are no lines, with an explanatory message.
- **#48** `client/src/lib/lineUpdateQueue.ts`: per-line serial queue, optimistic update, only the newest response applied, errors toasted and the import resynced from the server, `drain()` awaited before commit (rejects if a line's latest edit failed). Commit button also disabled while committing.
- **sendMutationError leak** `ValidationError(message, status=400)` in `lib/domain-helpers.js`; `cleanText`, `finiteNumber`, `cleanName`, `validForeignId`, `resolveTargetLocation`, the barcode conflict (409), invoice commit/patch validators all throw it. `sendMutationError(res, err, context)` echoes only `ValidationError`; everything else → `sendServerError` (correlation-id 500). The old `/already assigned/` regex is gone. Test `test/mutation-error-leak.test.js` (fails before: a DB error returned 400 with its text).

## Test changes outside the new files
- Invoice fixtures are reused across tests, so duplicates are now refused: `clearInvoiceImports()` in `test/setup.js`, used in `invoice-import*.test.js`; the memory tests clear between their two imports; `test/fresh-app.js` gained an optional `beforeLoad` hook; `test/auth-migration.test.js` pins `user_version = 4` instead of `migrations.length - 1`.
- e2e `v2-invoice-import.spec.js`: `beforeEach` clears invoice tables via `E2E_DB_PATH` (throwaway DB only); 5 new specs (duplicate open-existing, committed duplicate, clear-category persists, failed PATCH toast+resync, empty import). New testids in `test-e2e/testids.js`. Still imports `csp-guard`.

## Fail-before evidence
Leak test failed before the change (plain Error returned 409/400 with its text). The other new server tests exercise behaviour that did not exist (columns, 409s, flags), so they could not pass before by construction; I did not run each against the old code.

## Results (final tree)
See the commit/issue comment; `npm test`, client unit, client build, full e2e all green (numbers in the final summary).

## Review
`code-diff-reviewer`: score 12 (CALL). 3 Sonnet + 1 Mythos passes: all four returned NO FINDINGS (the known failure mode, so not taken as clean) → counsel `openai/gpt-5.6-terra` called, seeded with the nine changed source files only (no CHANGELOG/CLAUDE.md/commit messages, `issues_found: []`). Counsel found 7; acted on 4 (drain hid failed edits; loose foreign-key parsing; non-object PATCH body; double-commit), declined 3: parser-derived values are not validated (pre-existing, trusted deterministic parsers; the new trigger now stops negative stock), stale `tb_active_import_id` (a 404 already clears it), migration with a pre-existing `dedupe_key` column (never shipped). Cost of passes US$3.45 + counsel. Advisor ranked last (below).

## Not done / notes
- Legacy `/api/invoices/parse` + `/commit` flow: only validation added; it has no duplicate detection (no staging table to key on).
- Prices have no upper bound (only quantities were asked for).
- `null` quantity is still treated as 0 by `finiteNumber` (existing behaviour, all routes).
