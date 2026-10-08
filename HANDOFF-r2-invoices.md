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
Backend `npm test`: 42 files / 475 tests pass. Client unit: 18 files / 140 pass. Client `npm run build`: OK (and `tsc --noEmit` clean). Playwright e2e (locked): 62 pass.

## Review
`code-diff-reviewer`: score 12 (CALL). 3 Sonnet + 1 Mythos passes: all four returned NO FINDINGS (the known failure mode, so not taken as clean) → counsel `openai/gpt-5.6-terra` called, seeded with the nine changed source files only (no CHANGELOG/CLAUDE.md/commit messages, `issues_found: []`). Counsel found 7; acted on 4 (drain hid failed edits; loose foreign-key parsing; non-object PATCH body; double-commit), declined 2: stale `tb_active_import_id` (a 404 already clears it), migration with a pre-existing `dedupe_key` column (never shipped). Cost of passes US$3.45 + counsel. Advisor (last) reversed my initial decline of counsel's parser-values finding (parsed `qty_supplied` is the default commit quantity and bypassed `QUANTITY_MAX`): imported lines are now validated (422 `could not be read safely`) with tests. It also had the quantity-guard triggers moved after `runMigrations`, and the `drain()` message reworded.

## Not done / notes
- Nothing from the original "not done" list remains; see Follow-up below.

## Follow-up round (the three former "not done" items)

Commits: `615858a` (remove LLM-parse routes), `7f1462d` (numeric rules), `ce543e3` (item form blank threshold), plus the conditional-commit commit after it.

### 1. LLM-parse flow (`/api/invoices/parse`, `/api/invoices/commit`) — REMOVED
Evidence: no reference in `client/src`, `test-e2e/`, or any sibling worktree's client/e2e; its only front end was `/legacy`, retired in `566f16b` (#59). Removed: both routes, the `/api/invoices/parse` LLM-limiter path in `server.js`, `validateInvoiceItems` (+ tests) in `llm-schema.js`, `test/invoices.test.js`, the parse tests in `llm-anthropic`/`uploads`/`error-hardening`, the module-seam snapshot rows, and the CLAUDE.md database note. `test/legacy-invoice-routes-removed.test.js` (404s) failed before and passes now. No schema change. `invoiceUpload` stays (used by the import). If a future mobile app wants a parse-only call it should go through the deterministic import.

### 2. Numeric rule (applies everywhere; **integrator: apply to `POST /api/items/:id/merge`**)
All numeric input goes through `finiteNumber(value, { name, min, max, allowNull, defaultValue })` in `lib/domain-helpers.js`:
- Must be a number or numeric string; booleans, arrays and objects are rejected.
- A missing value (undefined, null, `''`, whitespace) is a **400 `<name> is required`** unless the caller states what missing means: `allowNull` (nullable field) or `defaultValue` (optional with an explicit default). Nothing is read as 0 silently.
- Bounds: `QUANTITY_MAX = 1,000,000` (quantities, amounts, reorder threshold), `PRICE_MAX = 100,000` (unit price / item price), `LINE_TOTAL_MAX = 10,000,000` (one invoice line total). Exported from `lib/domain-helpers.js`.
Per route: `POST /api/items` quantity and reorder_threshold optional, default 0; price optional (null = no purchase record), ≤ PRICE_MAX. `PUT /api/items/:id` reorder_threshold **required** (client sends an explicit 0 for a blank box, `numberOrZero`), price optional ≤ PRICE_MAX. `PATCH quantity`, `POST deduct`, `PATCH move-location`: `amount` required (`set` to an explicit 0 is fine), ≤ QUANTITY_MAX. Invoice import: parsed `unit_price` ≤ PRICE_MAX, `line_total` ≤ LINE_TOTAL_MAX, quantities ≤ QUANTITY_MAX, all nullable; a reviewer's `qty_confirmed` is nullable (null = use supplied); **import commit refuses (400) a kept line with neither confirmed nor supplied quantity** (skipped lines are fine); a missing price commits as 0. For the merge endpoint: a merge needs no new numbers unless it takes a quantity — if it does, use `finiteNumber(..., { name: 'Quantity', min: 0, max: QUANTITY_MAX })` (required), and any price with `max: PRICE_MAX, allowNull: true`.
Tests: `test/numeric-rules.test.js` (helper, every route, import), e2e blank threshold in `v2-item-detail.spec.js`, client `numberInput.test.ts`.

### 3. Review of this round
Score 9 (CALL). 3 Sonnet: NO FINDINGS; Mythos: 1 finding (real — PUT with a cleared threshold would have regressed to 400 because the client sends NaN→null); fixed client-side + e2e. Counsel (`openai/gpt-5.6-terra`, same seeding as before, 7 source files) found 7: acted on 1 (import commit flip now conditional inside the transaction; single-process better-sqlite3 cannot interleave, so this is hardening, tested by blinding the early check). Declined/flagged, all pre-existing or other branches' files: double-submit guard in `ItemFormModal` (r2-client's area), `parseFloat` use in the item form (number inputs; blank quantity on add = documented default 0), `is_open` truthiness, `purchase_date` format validation (**worth a future ticket**: free text is written to `price_history.recorded_at`), unbounded `/api/items/search`, no error UI for failed item saves, and "body must be an object" on item routes (Express's strict JSON parser already rejects scalar/null bodies).
