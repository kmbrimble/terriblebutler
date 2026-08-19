# Changelog

The minor version (after the dot) is an integer counter that increments by 1 each change: 0.1, 0.2 ... 0.9, 0.10, 0.11, and so on. The major version (before the dot) is NOT auto-incremented — it only advances when the user manually declares a milestone.

## [Unreleased]

### Plan: Fix reorder-threshold step in the React item-edit form

Bug 1 confirmed real (contrary to the initial report's premise): `public/index.html`'s
`itemThreshold` input also uses `step="0.1"` (confirmed by direct inspection, not assumed) —
this stage-3 regression report is actually a pre-existing legacy usability bug that was never
caught before. Per explicit user decision, this fix deliberately diverges from legacy: only
`client/src/components/ItemFormModal.tsx`'s threshold input changes to `step="1"`; legacy
(`public/index.html`) is untouched, since "match legacy" was never the goal for this specific
field once the legacy behaviour itself was identified as the bug.

Bug 2 investigated independently before assuming it shares bug 1's cause: built a diagnostic
e2e probe (edit an item's threshold via keyboard ArrowUp/Down on the field, submit, check the
Grocery List tab) — the save → refetch → grocery-tab-filter pipeline itself works correctly
for whatever value actually gets saved (proven by testing with `step="0.1"` still in place,
before this fix: pressing ArrowUp 30 times from 0 produced a clean "3", saved correctly, and
the item appeared in the Grocery List tab immediately). Live DB also checked (read-only): no
existing item has a fractional `reorder_threshold`, so tightening to `step="1"` won't trip
HTML5 step-mismatch validation on an existing row's edit. Conclusion: bug 2 has no separate
code-level cause — it's downstream UX fallout from bug 1 (a user aiming for a whole-number
threshold via the confusing 0.1-per-click spinner easily lands on an unintended fractional
value, e.g. 0.3 instead of 3, which then legitimately fails `quantity <= reorder_threshold`).
Fixing the step to 1 resolves both.

**Fix:** `client/src/components/ItemFormModal.tsx` — `step="0.1"` → `step="1"` on the
reorder-threshold input only. No other field, `server.js`, or `public/index.html` change.

## 0.22 - 2026-08-19

### React client stage 3 — item detail and editing

Brings `/v2` to parity with `public/index.html` for: add item, edit item, quantity
adjustment (+/- and manual set), deduct, and ignore/restore from the grocery list.
Confirmed against server.js and public/index.html directly (not inferred from stage 2):

- Routes: `POST /api/items`, `PUT /api/items/:id`, `PATCH /api/items/:id/quantity`
  (`{amount, action: 'add'|'subtract'|'set', location_id?}`, location inferred when the
  item has exactly one location, required/optional otherwise), `POST /api/items/:id/deduct`
  (`{amount, location_id?}`), `PATCH /api/items/:id/ignore-grocery`
  (`{is_ignored_grocery: 0|1}`), `GET /api/items/match?name=&barcode=` (duplicate check).
  All item mutations broadcast `inventory_updated` with a full item payload — already
  refetched by `ItemList`'s existing socket listener, so no new socket wiring is needed.
- Legacy quirks to replicate exactly, not "improve": editing hides location/quantity
  entirely (stock is per-location, ambiguous otherwise); the qty +/- buttons apply a
  direct ±1 delta only when unambiguous (single location, or a location tab is active) —
  for a multi-location item viewed outside a location tab, +/- opens a manual "set exact
  quantity" modal with a location picker instead of guessing; ignore/restore button
  visibility is driven by which tab is active (`grocery`/`ignored`), not by reading the
  item's own flag; duplicate-check on add offers "Use this" (merges qty into the existing
  item) or "Add as new item anyway".
- Null-in-practice audit against the **live** database (read-only query, not fixtures):
  of the fields this stage reads/writes, `container_details`, `quantity`,
  `reorder_threshold` are clean (0/51 NULL). `barcode` (49/51) and `category_id` (50/51)
  are already `T | null` in `api.ts` and already guarded in the legacy edit-prefill this
  stage ports. `is_ignored_grocery` is NULL on 1 live row (`id 11`, "Basa cooked" — the
  same row with NULL prices from the previous fix) despite `DEFAULT 0`, confirming the
  ad-hoc-ALTER-history risk isn't limited to prices — but the ignore/restore button reads
  the *active tab*, never the item's own flag, so there's no formatting/crash path for it
  in this stage's new code; the only reader of the raw flag is stage 2's `filterItems.ts`
  (untouched), which is already null-safe via strict `=== 0`/`=== 1` equality.
- Out of scope, confirmed separable in the legacy modal: barcode scanning, "Snap Label
  with LLM" / image crop, and the location/category "suggest" blocks that only appear
  after an LLM scan.

**Files:** `client/src/lib/api.ts` (add `createItem`/`updateItem`/`updateItemQuantity`/
`deductItem`/`setIgnoreGrocery`/`matchItem`, widen `Item.is_ignored_grocery` to
`number | null`), new `client/src/lib/cardQuantity.ts` (pure, unit-tested — ports
`cardQuantity()`'s tab-aware per-location display), new `client/src/components/Header.tsx`,
`ItemFormModal.tsx` (add+edit, shared, matching the legacy single-modal reuse), `DeductModal.tsx`,
`QtyModal.tsx`; `ItemCard.tsx` extended with edit/qty/ignore controls; `ItemList.tsx` extended
to own modal-open state and render the above. New testids added to `test-e2e/testids.js`
(extending the stage-0 contract, not forking it) for fields/controls the legacy DOM has no
testid for. `public/index.html` is not touched at all this stage.

**Tests:** new `test-e2e/v2-item-detail.spec.js` (add, duplicate-detect/override, edit,
quick-adjust incl. the ambiguous-multi-location case, deduct incl. the location-picker
case, ignore/restore); new `client/src/lib/cardQuantity.test.ts`; new
`client/src/components/ItemFormModal.test.tsx` (constructed-object unit tests for the
null-guarded edit-prefill fields — barcode/category_id/container_details/reorder_threshold
— since neither e2e fixtures nor the live API can produce a fresh NULL for a
DEFAULT-backed column, matching the precedent from the last fix).

Two real issues surfaced and fixed while getting the new e2e spec green (both in the test
file, not the app code):
- **Shared mutation-rate-limit budget**: measured that the legacy + stage-1/2 v2 specs
  already consume 87 of the shared `mutationRateLimiter`'s 90-requests/60s budget (the whole
  suite completes well inside one window), leaving ~3 mutations of headroom before this
  file's own fixtures even start — nowhere near enough regardless of fixture consolidation.
  Fixed by having this file's `beforeAll` read the `RateLimit-Remaining`/`RateLimit-Reset`
  headers server.js already returns on every mutation response, and waiting out the rest of
  the window when the shared budget is nearly exhausted — a conditional wait driven by the
  server's own state, not a blind sleep, so an isolated run of just this file never waits.
  server.js's rate limiter itself is untouched, per this stage's scope guard.
- **Fuzzy-match false positive**: `GET /api/items/match` uses Fuse.js (threshold 0.3)
  against every existing item's name. This file's own fixtures all share an
  `E2E Detail <timestamp> ...` prefix; a new "add" fixture that also started with that
  pattern intermittently (timestamp-digit-dependent) scored inside the fuzzy threshold
  against a sibling fixture, wrongly surfacing the duplicate-check panel. Root-caused by
  reproducing the failure in isolation with zero rate-limit pressure and looping it ~10
  times with response/console listeners attached before finding the cause. Fixed by giving
  that one fixture a name sharing zero words with the others.

Verified stable: full suite (`npm test` + `npm run test:e2e`) run twice back-to-back,
36/36 e2e and 192+31 unit tests green both times, zero 429s.

**Tests:** `npm test` — backend 192/192, client unit 31/31 (11 new: 4 `cardQuantity`, 7
`ItemFormModal`). `npm run test:e2e` — 36/36 (3 new specs), confirmed stable across two
consecutive full runs.

## 0.21 - 2026-08-19

### Fix: ItemCard crash on null last_price/lowest_price

Root cause confirmed (not assumed): `items.last_price`/`lowest_price` are `REAL DEFAULT 0`
columns, but that `DEFAULT` was added later via `ALTER TABLE`, so pre-existing live rows are
genuinely `NULL` (fresh rows via `POST /api/items` always get 0, which is why neither the e2e
fixtures nor the unit-test `makeItem()` helpers ever hit this). `client/src/components/
ItemCard.tsx`'s expanded view calls `item.last_price.toFixed(2)` / `item.lowest_price.toFixed(2)`
with no null guard, crashing the whole page. `public/index.html`'s equivalent (working) code
uses `(item.last_price || 0).toFixed(2)` — that's the convention to match, not invent a new one.

- `client/src/lib/api.ts`: widen `Item.last_price`/`lowest_price` to `number | null`, matching
  the real (nullable) response shape.
- `client/src/components/ItemCard.tsx`: guard both `.toFixed()` calls with `|| 0`, matching
  `public/index.html` exactly.
- New `client/src/components/ItemCard.test.tsx`: renders `ItemCard` via `react-dom/server`'s
  `renderToStaticMarkup` (already a dependency, no new test infra needed) with a fixture item
  that has `last_price`/`lowest_price: null`, asserting expanded view renders without throwing
  and falls back to `$0.00`. A true e2e fixture can't reproduce this: `POST`/`PUT /api/items`
  and `recalculateItemPrices()` always write `|| 0`, never `NULL` — the null state only exists
  on old rows from before the schema's `DEFAULT 0` was added, so a unit test constructing the
  `Item` object directly is the accurate way to cover it, not an API-driven e2e fixture.
- `client/vitest.config.ts`: widen `include` to pick up `.test.tsx` files.
- Scope: null-handling only. No other ItemCard/stage-2 behaviour change, server.js untouched.

**Tests:** `npm test` — backend 189/189, client unit 20/20 (4 new, added by this fix). `npm run
test:e2e` — 33/33, unaffected (confirms the fix doesn't touch stage-2 behaviour).

## 0.20 - 2026-08-19

### React client stage 2 — inventory list, tabs, sort/filter/view-mode

Ports `public/index.html`'s browsing UI (tabs, search, sort, view-mode, item cards) into the
`/v2` React client, matching its exact filter/sort/search behaviour — the single-fetch
architecture (`GET /api/items` once, all filtering/sorting/search done client-side, including
Grocery/Ignored tabs) confirmed by reading `renderItems()`/`renderTabs()`/`fetchItems()`
directly, not assumed. No add/edit/deduct/scan/modal UI this stage — item cards are read-only.

- New `test-e2e/v2-inventory.spec.js`: tab filtering (all/location/grocery/ignored), search
  combined with the active tab (not replacing it), all four non-timestamp sort keys (name,
  quantity, category, location) in both directions plus `created_at`/`updated_at` verified
  against real, deliberately-delayed timestamps (proving they're independent of each other),
  sort/view-mode persistence across reload (same `tb_sort_by`/`tb_sort_dir`/`tb_view_mode`
  localStorage keys as the legacy app), an empty-state check, and two-browser-context
  live-update tests for `inventory_updated`/`locations_updated` (both carry empty or
  client-ignored payloads by design — the client always refetches, never reads the payload).
  Committed failing (undefined UI) first.
- `client/src/lib/`: `filterItems.ts` and `sortItems.ts` as pure, non-mutating functions
  (`(items, tab, search, sortBy, sortDir) → Item[]`), porting `renderItems()`'s switch
  statements and search predicate faithfully, including the exact tie-break (stable sort,
  `return 0` on equal keys), with their own unit test suite. `preferences.ts` wraps the three
  localStorage keys. `api.ts` gains typed `getItems`/`getLocations`/`getCategories`/
  `getGroceryList`/`getOutOfStockIgnored`/`createLocation`, with `Item`/`Location`/`Category`
  types read from `parseItemLocations`/the SQL column list in server.js, not guessed.
- `client/src/components/`: `TabBar`, `ItemCard` (compact/expanded), `SortControl`,
  `ViewModeToggle`, `SearchInput`, `ItemList` (owns items/locations/categories state, the
  socket refetch subscriptions, and renders the empty state).
- `client/vitest.config.ts` + colocated `*.test.ts` files: 16 unit tests for the pure
  filter/sort functions, wired into the root `npm test` via a new `test:client` script — plain
  TypeScript, no DOM/React needed to test them, reusable as-is by the eventual React Native app.
- New testids in `test-e2e/testids.js`: `search-input`, `sort-select`, `sort-dir-button`,
  `view-mode-toggle`, `item-list`, `empty-state`. `item-card` gets a `data-view-mode` attribute
  so the two layouts are distinguishable in tests without relying on incidental class names.
- Deliberate minor divergence: barcode search is lowercased on both sides (case-insensitive),
  where the legacy code lowercases only the search term. Harmless for real data (barcodes are
  digits only, so case doesn't arise) and matches this stage's own test spec explicitly asking
  for case-insensitive barcode search.
- Empty state: a filtered/sorted/searched view with zero results renders a
  `data-testid="empty-state"` "No items found." message (ported verbatim from the legacy
  app's own `renderItems()` fallback) rather than an empty container or an error — verified for
  a location tab with no matching items, per this stage's explicit "Done when" requirement.
- **Rate-limiter discovery mid-implementation:** `server.js` already applies a
  `mutationRateLimiter` (90 POST/PUT/PATCH/DELETE/60s/IP) and `generalApiRateLimiter` (240
  `/api` requests including GETs/60s/IP) — a real, pre-existing production safety feature, out
  of this stage's scope to change. The legacy 24-spec suite alone consumes 69 of the mutation
  budget. `v2-inventory.spec.js` was iterated to fit comfortably within what's left: fixtures
  are created once in `beforeAll` and heavily multi-purposed (one item/location pair proves
  four different sort keys simultaneously), and independent read-only assertions are merged
  into a single `page.goto()` rather than one per scenario, since every page load costs three
  GETs. Final suite run: zero HTTP 429s.
- Not the 1.0 milestone.

**Tests:** `npm test` — backend 189/189, client unit 16/16. `npm run test:e2e` — 33/33 (24
legacy + 3 `v2-login` + 6 `v2-inventory`, all fully green, zero rate-limit errors).

### React client stage 1 — scaffold + auth path at /v2

Scaffold a Vite + React + TypeScript client under `client/`, served at `/v2` alongside the
existing `public/index.html` front end (which stays untouched and keeps serving `/`). This
stage proves the build, the serving route, and the auth/socket foundation with a login screen
only — no inventory UI.

- New `test-e2e/v2-login.spec.js`: logged-out state renders the login screen at `/v2`, wrong
  credentials show an error without navigating, correct credentials reach the authenticated
  view with the socket observably connected (a DOM attribute polled by Playwright, not a
  sleep). Reuses `LOGIN_SCREEN`/`LOGIN_USERNAME_INPUT`/`LOGIN_PASSWORD_INPUT`/
  `LOGIN_SUBMIT_BUTTON`/`LOGIN_ERROR`/`APP_ROOT` from `test-e2e/testids.js` unchanged — proof
  the stage-0 contract is genuinely front-end agnostic. Committed failing (404 at `/v2`) first.
- `client/`: its own `package.json` (not an npm workspace), Vite + React + TypeScript, built
  with `base: '/v2/'`. `client/src/lib/` (api/token/socket) is plain TypeScript with no
  React/DOM-library imports — the layer the eventual React Native app reuses. Uses the same
  `tb_token` localStorage key as the existing front end.
  Tailwind is a real build here (not the CDN script `public/index.html` uses) — the `rimmy`
  colour palette and CSS custom properties are ported from `index.html`'s `<style>`/tailwind
  config blocks verbatim.
- `server.js`: mounts the built client at `/v2` (static assets, then an SPA fallback for deep
  links), registered after the existing static mounts and scoped so it structurally cannot
  shadow `/api` or `/uploads`. `APP_VERSION` bumped to match this changelog entry, resolving
  the drift a prior task's scope guard left behind.
- `Dockerfile`: new `client-builder` stage (its own `npm install`, since the existing builder
  stage's `npm install --production` never installs the client's Vite/TS devDependencies) whose
  built `client/dist` is explicitly copied into the runtime stage. The client's
  `node_modules`/devDependencies never reach the runtime image (`.dockerignore` excludes them
  from the build context entirely); the runtime stage's pre-existing blanket `COPY . .` does
  still sweep in the client's small source/config files alongside everything else not
  `.dockerignore`d — a known, deliberately-left minor inefficiency, not the devDependency bloat
  the plan was actually guarding against.
- Root `package.json`: `pretest:e2e` builds the client before every `npm run test:e2e` run, so
  a missing or stale `client/dist` fails the npm script chain loudly instead of 404ing quietly
  into a passing suite.
- Secondary: broadened `test/e2e-selector-guard.test.js`'s raw-selector regex — it previously
  only matched an id/class at the very start of a selector string, across six method names.
  It now matches an id/class anywhere in the selector (across a wider method list, including
  `waitForSelector`/`$`/`$$`), while still explicitly allowing bare tag selectors like
  `header` (a stable HTML landmark, not implementation-detail wiring).
- Not the 1.0 milestone — that's reserved for shipping the React Native app.

**Tests:** `npm test` 186/186 (backend suite unaffected). `npm run test:e2e` 27/27 — the
existing 24 (front end at `/` still fully green) plus 3 new `/v2` login specs. Docker image
built locally and verified directly (CI only builds/pushes the image, it does not run tests):
`/v2/` and SPA-fallback deep links return 200 with the built client, `/v2/assets/*` serves the
real JS/CSS, `/` still serves the legacy front end, `/api/health` reports version `0.19`,
`/api/items` still 401s unauthenticated, `/uploads` is still reachable — confirming `/v2`
cannot shadow `/api` or `/uploads`.

## 0.18 - 2026-08-18

### data-testid contract for the e2e suite (React rewrite prep)

Decoupled `test-e2e/` from `public/index.html`'s implementation details (element ids, the
`.item-card` class, `onclick="..."` attribute selectors) so the same Playwright suite can act
as acceptance criteria for a future React front end.

- New `test/e2e-selector-guard.test.js` (Vitest): fails if any spec uses an `[onclick=...]`
  selector, a raw `#id`/`.class` selector, or a `getByTestId` identifier not exported from
  `test-e2e/testids.js`. Committed failing first as the checkpoint; the CSS-selector regex is
  deliberately narrow to `#id`/`.class` only (per the plan), so it doesn't flag the two
  `option[value="..."]` attribute lookups still used in `label-scan-suggestion.spec.js` —
  those are scoped inside a `getByTestId(...)` locator and aren't id/class selectors.
- New `test-e2e/testids.js`: 39 kebab-case testid constants, named for what each element *is*
  (e.g. `item-card`, `deduct-submit-button`), not where it sits in the DOM.
- `public/index.html`: add-only `data-testid` attributes matching the contract (35 sites,
  including one set at runtime on the dynamically-created toast element) — no existing id,
  class, or onclick handler removed or renamed; current front end behaviour unchanged.
- `playwright.config.js`: explicit `testIdAttribute: 'data-testid'`.
- All 11 specs rewritten to `page.getByTestId(...)`, importing the shared constants.
  `getByRole`/`getByText` selectors left untouched (already framework-agnostic).
- Invoice-import staging rows keep their per-row dynamic id (`il_cat_${lineId}`) internally,
  but each row now also gets a stable `invoice-import-line` testid + `data-line-id` attribute,
  so specs scope into the row (`getByTestId(...).and(locator('[data-line-id="..."]'))`) instead
  of selecting the dynamic id directly.
- `server.js`'s `APP_VERSION` constant was intentionally left at `0.17` — the task scope guard
  excluded `server.js` from this change, so it now trails this changelog entry by one version.
- Internal test infrastructure only — no user-facing change, not the 1.0 milestone.

**Tests:** `test/e2e-selector-guard.test.js` (33 assertions across the 11 specs); full local
suites re-verified: `npm test` 183/183, `npm run test:e2e` 24/24 (same count before and after —
the sandbox's Playwright system libraries were missing at the start of this session and were
installed as part of verification, which is why the "before" run also needed a rerun to confirm
a fair baseline).

### Nightly database backups, 2-week retention (#17)

New `backup.js`: `runBackup(db, dir)` uses better-sqlite3's online `db.backup()` API
(WAL-safe, same mechanism `CLAUDE.md`'s manual pre-change backup process already uses) to
write `data/backups/inventory-YYYY-MM-DD.db`; re-running on the same day overwrites rather
than accumulating duplicates. `pruneOldBackups()` deletes any backup file older than 14 days
(mtime-based). `scheduleNightlyBackup()` runs it at 02:00 local time and every 24h after,
wired into `server.js` only inside the `require.main === module` guard so tests never trigger
it. Backups live under `data/backups/`, which is already the bind-mounted, persistent path —
no new volume mount needed.

**Tests:** 8 new (`test/backup.test.js`) — backup produces a restorable, integrity-checked
copy; same-day overwrite; pruning by age; pruning ignores unrelated files; no-op on a missing
directory.

### Verbose action logging with weekly rotation, 1-month retention (#14)

New `logger.js` + a generic Express middleware on `/api/*` (mutating methods only, registered
in `server.js` right after the JSON body parser) that wraps `res.json` to capture method,
path, status, duration, request body, and response body for every action — covers
add/remove/edit/scan/LLM-response/auth failures uniformly, without touching each of the ~20
route handlers individually, and also catches the global error handler since it responds via
`res.json` too. Logs go to both stdout (`console.log`, visible via `docker logs`, per the
user's explicit request) and a file `logs/actions-<week-start-monday>.log` — one file per
week, so "rotation" is just a new filename, no rename step needed. `pruneOldLogs()` deletes
log files older than 30 days (mtime-based), run on each write. `password`/`token` fields are
redacted in both request and response bodies before logging. `LOG_DIR` env var override added,
mirroring the existing `DB_PATH` test seam, and set to a per-run temp directory in
`test/setup.js` so tests never write to the repo's real `logs/`.

**Tests:** 8 new (`test/logger.test.js`) covering week-label computation, file+stdout writes,
redaction, and pruning; 3 new (`test/action-logging.test.js`) integration-testing the
middleware against the real server — a real mutation gets logged with correct fields, GETs are
skipped, and a login attempt's password/token are redacted end-to-end.

### Invoice import: deterministic Coles/Woolworths parsers, staging table, review UI

- **Part 1 — parsers.** `parsers/woolworths.js` and `parsers/coles.js` parse already-extracted
  PDF text (via `pdf-parse` v2's `PDFParse` class — the existing `/api/invoices/parse` route
  uses the old v1 callable-function API and is currently broken as a result; that's a
  pre-existing bug outside this task's scope and is left untouched) into the shared line-item
  contract, with no LLM involved. `parsers/router.js` detects retailer by ABN string and
  dispatches. `parsers/shared.js` holds the `D Month YYYY` → ISO date parser used by both.
  Fixtures moved to `test/fixtures/invoices/{woolworths,coles}-example.pdf`.
- **Part 2 — staging tables + API.** New `invoice_imports` / `invoice_import_lines` tables
  (idempotent `CREATE TABLE IF NOT EXISTS`, added directly to `server.js`'s schema block since
  these are brand-new tables, not alterations to existing ones — no `db-migrations.js` entry
  needed). Four new `/api/invoices/import*` routes, all behind the existing `requireAuth`
  gate. Matching hierarchy at import time reuses `findMatch`: exact-name (or barcode) match
  sets `matched_item_id` and inherits that item's category/location as the suggestion; a
  fuzzy hit populates the suggestion from the top candidate but leaves `matched_item_id` null
  (deliberately stricter than the spec's literal wording of also auto-setting it on fuzzy —
  kept consistent with `item-matching.js`'s documented project-wide rule that fuzzy matches are
  suggestion-only, never auto-applied, since this is a money/inventory-affecting write path).
  Lines with no deterministic match fall back to a new text-only LLM classify call (reusing the
  granite vision model in text mode, `response_format: json_schema`, a new
  `validateClassifyResult` in `llm-schema.js`); failures/timeouts degrade to a null suggestion
  rather than blocking the import, same resilience pattern as `/api/parse-label-llm`. Commit
  re-runs `findMatch` for any still-unmatched line (covers two new lines in one import sharing a
  name) inside a single `db.transaction`, so a mid-commit failure (e.g. a bad FK) rolls back
  atomically and `invoice_imports.status` stays `in_progress`. Staging rows are never deleted
  after commit — they're the audit trail.
- **Part 3 — review UI.** New screen in `public/index.html`, one row per staging line, editable
  category/location (pre-filled from suggestions, reusing the existing suggestion-picker
  pattern), qty-confirmed field, barcode-scan button reusing the existing scanner component.
  Every field edit PATCHes immediately (no save button) so a reload mid-review restores state
  from `GET /api/invoices/import/:id`. Commit button enabled once no line is `pending` — enforced
  server-side too, not just as a UI gate.
- **Out of scope, per the brief:** manual retailer picker UI for the "unknown retailer" case
  (Part 1's router returns a clear `retailer: null` result for this; Part 3 doesn't specify a
  picker, so the review screen just surfaces the error) — flagged in the hand-back rather than
  built speculatively.

**Two bugs found and fixed during review, both pre-existing conditions this feature exposed:**

1. `items.location_id` turned out to be a column `POST /api/items` deliberately never writes
   (`item_locations` is the real source of truth since the multi-location migration) — the
   import route's first draft read it for match-suggestion location, always got `null`, and
   wrote to it on new-item creation. Fixed to derive a location suggestion from
   `item_locations` (only when an item lives in exactly one location — otherwise ambiguous)
   and to stop writing the vestigial column, matching `POST /api/items`'s own convention.
2. The two new staging columns' FKs to `categories`/`locations` meant deleting a category or
   location that had ever been suggested or selected on an *uncommitted* staging line failed
   with a live `FOREIGN KEY constraint failed` — `DELETE /api/categories/:id` and
   `DELETE /api/locations/:id` already null out `items.category_id` /
   `item_locations.location_id` before deleting, but didn't know about the new
   `invoice_import_lines` columns. Fixed both routes to null those out too, in the same
   transaction. Covered by a new regression test.

Also parallelised the per-line LLM classify fallback (`Promise.all` instead of a sequential
loop) — with a 32-line invoice and no existing-item matches, awaiting each one one-at-a-time
would have meant minutes of serial network latency the UI is blocking on for something that's
naturally parallel.

**Tests:** 137 backend (Vitest) + 24 e2e (Playwright), all green — 40 new backend tests
(parsers 24, staging API 16) and 3 new e2e tests for the review screen, plus the two pre-existing
suites re-verified with no regressions.

**Retailer detection:** confirmed correct against both fixtures (Woolworths via
`ABN 88 000 014 675`, Coles via `ABN: 45 004 189 708`) and a clear `null` result for neither.

**Parsing edge cases found in the fixtures, not anticipated in the brief:**
- Woolworths: one product description ("Nestle golden rough milk chocolate...") wraps across
  two physical PDF text lines before its numeric columns appear — handled by buffering an
  in-progress description until a line resolves to a complete row.
- Woolworths: a weighted item's Supplied quantity carries a literal `" kg"` suffix
  (`8.05 kg`) rather than being a plain number.
- Woolworths: the totals block's *values* (`$432.15` etc.) are printed on page 2, textually
  separated from their *labels* on page 1 by the second page's product-table continuation —
  harmless for parsing since neither the label lines nor the bare-value lines match the
  product-row shape, but worth flagging as a PDF-extraction-order quirk if a future retailer
  format needs an explicit "stop" marker instead of shape-matching.
- Coles: out-of-stock rows split across two physical lines (bare product name, then a
  separate `Out of Stock <qty> ...` line with no product-row shape) — both are naturally
  excluded by the row-shape check, no special-casing needed beyond the explicit
  "contains literal text" guard the brief asked for.

**Pre-change reminder:** this adds two new tables — snapshot the live DB to
`/mnt/user/Kieren/Backup/unRAID/butler/` before deploying, per `CLAUDE.md`.

### Pin Playwright to 1 worker

`playwright.config.js` didn't set `workers`, so Playwright defaulted to a CPU-core-based
worker count (8 on a 16-core box) since `CI` isn't set in this environment. `global-setup.mjs`
starts one shared server + SQLite DB on a fixed port for the entire e2e run — every test in
every worker hits that same live instance. Ran the suite four times back-to-back at the
default 8 workers to check whether that holds up under concurrency: one run crashed the shared
server outright (17 tests failed with `ECONNREFUSED`), another had two unrelated tests fail for
different reasons (a `/api/categories` POST came back without an `id`; a location delete
returned `false`). Real flakiness, not slowness, and it moved between different files each
run — a shared-instance architecture problem, not a bad test. The suite already runs in
single-digit seconds serially, so pinned `workers: 1` rather than chase a marginal speedup that
trades away trust in the suite. Per-worker isolated server+DB+port (Playwright's
`testInfo.workerIndex`) would make real parallelism safe — worth it if the suite grows enough
for serial runtime to matter, not worth it at today's size (21 e2e tests, ~7–18s).

**Files:** `playwright.config.js`.

### Label-scan LLM: fix schema-drift root cause, close silent-parsing gap, add category/location suggestion picker

**Plan:** investigation (prompted by "scanned items always get the same category/location")
found two stacked bugs in `/api/parse-label-llm`:

1. **Root cause:** the route sends a raw top-level `format: {...}` JSON-schema field in the
   payload to Ollama's OpenAI-compatible `/v1/chat/completions` endpoint. That field is the
   native Ollama `/api/chat` structured-output mechanism and is silently ignored on the
   OpenAI-compat endpoint — verified empirically (identical hallucinated, off-schema output
   with the field present vs entirely absent, against real fixture photos). Fix: send
   `response_format: { type: 'json_schema', json_schema: { name: 'label_result', schema } }`
   instead, which Ollama 0.32.13 does honour on this endpoint.
2. **Downstream gap:** `validateLabelResult` (`llm-schema.js`) only checked that the top-level
   parsed value was a non-null, non-array object, then silently coerced any missing
   `name`/`category_name`/`location_name` to `''`. A fully hallucinated, off-schema response
   (e.g. `{"A images":1,"A descriptions":"..."}`) passed with zero reported errors, ending up
   indistinguishable from "the model legitimately found nothing." Fix: explicitly flag missing/
   empty `name`, `category_name`, `location_name` as `schema mismatch: ...` errors
   (`container_details` stays optional/blank-tolerant, per its existing comment).

Also, per user request: when the LLM's `category_name`/`location_name` doesn't exactly match
an existing category/location, the route now returns the raw suggested name plus the best
Fuse.js fuzzy match (if any, threshold 0.3 — same convention used elsewhere in `server.js`)
instead of silently dropping to `null`. The frontend shows an inline suggestion picker (styled
like the existing `dupCheckPanel`/invoice-fuzzy-match patterns) offering: add the suggested
name as a new category/location, pick an existing one (pre-selected to the fuzzy match if
present), or type a different new name.

**Files:** `server.js` (`/api/parse-label-llm` payload + category/location matching),
`llm-schema.js` (`validateLabelResult`), `public/index.html` (`confirmCrop` result handling +
new suggestion-picker UI), `test/llm-schema.test.js`, new
`test-e2e/label-scan-suggestion.spec.js`.

### Issue #12 — hold-for-details activates while scrolling

**Plan:** item cards opened the details modal via a 500ms press-and-hold timer
(`startPress`/`cancelPress`, bound to `mousedown`/`touchstart` + `mouseup`/`touchend`/
`touchcancel`/`mouseleave`). A finger held still on a card while the page scrolls under
it (e.g. a scroll gesture that starts on a card) still counts as a "hold," since nothing
cancelled the timer on movement — only on release. Replacing with double-tap/double-click
via the native `click` event fixes this by construction: browsers don't fire `click`
after a drag/scroll gesture, so there's no separate scroll-detection logic needed.

**Files:** `public/index.html` — replace `startPress`/`cancelPress`/`pressTimer` with a
single `handleCardTap(event, id)` tracking the last tap's id/timestamp; card templates
drop five touch/mouse attributes for one `onclick`. New
`test-e2e/card-double-tap.spec.js`.

**Shipped as planned**, no deviations. Tests: `test-e2e/card-double-tap.spec.js` (single
click doesn't open the details modal, double click does) — 90 backend + 17 e2e tests
passing.

**Sprint plan (2026-08-16):** multi-issue improvement sprint ahead of the React Native
migration, covering GitHub issues #8, #5, #6, #7, #9, #10 (issue #1 — multi-location
inventory — and #2 — voice integration — deferred to their own sessions). One feature
branch per issue, sequential, each merged to `main` only once its own tests are green.
Pre-sprint safety net: live DB snapshotted to
`/mnt/user/Kieren/Backup/unRAID/butler/inventory-2026-08-17-presprint.db`, and `main`
tagged `pre-sprint-2026-08-17` (pushed).

### Issue #8 — migrations table / schema version tracking

**Plan:** add a minimal, native-SQLite migrations runner (`PRAGMA user_version`, no new
table) in a new `db-migrations.js`, required from `server.js`. `server.js`'s existing
`CREATE TABLE IF NOT EXISTS` block remains the source of truth for the schema on a
*fresh* database (tests, new installs) — on a fresh DB, `user_version` is set straight
to the top of the migrations list with nothing replayed. On an *existing* database
(the live DB, or any DB from before this change), pending migrations from the current
`user_version` onward run once, each wrapped in its own transaction, then the version is
bumped. The `migrations` array starts empty; future ad-hoc `ALTER TABLE ADD COLUMN`
changes become entries in this array instead, each expected to guard itself with
`hasColumn()` before altering (belt-and-braces per CLAUDE.md's "must be idempotent and
safe against an already-populated database" rule — the version gate already prevents
replay in normal operation).

**Files:** new `db-migrations.js` (runner + `hasColumn` + `migrations` array, CommonJS to
match `server.js`); `server.js` lines ~163–214 (capture `isFreshDb` before opening the
DB, call `runMigrations` after the `CREATE TABLE` block); new `test/db-migrations.test.js`
unit-testing the runner directly against a scratch better-sqlite3 database (fresh-DB
path, existing-DB path, idempotency on repeated calls, `hasColumn`).

### Issue #5 — invoice matching improvements + manual-add duplicate detection

New `item-matching.js` (`normaliseName`, `findMatch`) implements the shared hierarchy:
barcode match > exact normalised-name match > user-confirmed (`matchDecision`) > fuzzy
(suggestion only, never auto-applied).

- `POST /api/invoices/commit`: rewritten to use `findMatch` instead of a bare Fuse
  search. Barcode/exact-name matches auto-apply (deterministic, safe); a fuzzy match is
  only used if the client sends an explicit `matchDecision` (an existing item id, or
  `'new'` to force a new item). As each new item is inserted during the commit loop, it's
  pushed into the in-memory `existingItems` array and `fuse.setCollection()` re-indexes,
  so later line items in the same invoice can match items the invoice itself just
  created. Invoice items may now optionally carry a `barcode` field.
- New `GET /api/items/match?name=&barcode=` — read-only lookup used by both the invoice
  staging UI and the manual add-item flow.
- `public/index.html`: invoice staging list now calls `/api/items/match` per parsed line
  item and shows a badge (barcode/exact-name) or a "possible match" dropdown (fuzzy,
  defaults to "add as new") that feeds `matchDecision` into the commit payload. The
  add-item modal now checks for a match on submit (new items only) and, if found, shows
  candidates with their match-confidence level, letting the user reuse an existing item
  (adds the entered quantity via the existing `PATCH /api/items/:id/quantity` endpoint)
  or override and add as new.

**Tests:** `test/item-matching.test.js` (unit), `test/invoices.test.js` (commit
hierarchy + in-memory update), `test/items.test.js` additions (`/api/items/match`),
`test-e2e/duplicate-detection.spec.js` (manual add reuse/override flows).

### Issue #6 — LLM response schema validation

New `llm-schema.js` (`validateLabelResult`, `validateInvoiceItems`) treats LLM JSON output
as untrusted: non-object/malformed responses fall back to safe empty defaults instead of
propagating `undefined`/wrong-typed values; invoice line items missing a name or a valid
non-negative `quantity` are dropped (logged via `console.warn`) rather than reaching the
DB; an invalid `price` defaults to `0` rather than dropping the whole item.

- `POST /api/parse-label-llm`: the route's existing ad-hoc type-checking (container_details
  object-vs-string coercion, name type guard, category/location lowercase matching) is now
  centralised in `validateLabelResult` — same behaviour, one tested place instead of scattered
  inline checks.
- `POST /api/invoices/parse`: previously passed the LLM's `items` array straight to the
  client with no shape checking at all. Now runs through `validateInvoiceItems` first.

**Tests:** `test/llm-schema.test.js` — unit tests covering both validators directly
(malformed/non-object input, wrong types, missing fields, the object-shaped
`container_details` quirk observed from the vision model). No LLM-mocking infrastructure
exists in this repo yet, so the route wiring itself (thin glue around the now-tested
validators) isn't separately black-box tested — `npm test`'s smoke test confirms the
server still boots with the new require wired in, and the pre-existing backend/e2e suite
(74 + 11 tests) passing unchanged confirms no behaviour regression for well-formed input.

### Issue #7 — standardise front-end HTTP error handling

`public/index.html` had ~22 `apiFetch` call sites with inconsistent error handling: some
checked `res.ok` and threw, most didn't; failures were shown via blocking `alert()`,
`console.error`-only, or silently swallowed; several mutation handlers (category/location
add/edit/delete) ran their success code — clearing the input field — even when the
server returned a non-2xx response, because `apiFetch` never threw on failure.

New `apiRequest(url, options)` wraps `apiFetch`: catches network errors, checks `res.ok`,
and on either failure shows a standardised error toast (extracting the server's `error`
message from the JSON body when present) then throws — so callers' post-request code
only runs on success. Pass `{ silent: true }` for the handful of call sites that need
custom status handling (`/api/items/match` lookups that deliberately fall back to "no
match" rather than erroring; the barcode-lookup 404 case, which isn't really an error).
All ~20 non-silent call sites were switched from `apiFetch` to `apiRequest`, dropping
their now-redundant per-site `if (!res.ok) throw` / `catch { alert(...) }` boilerplate.

- `showToast(message, type)`: now supports an `error` variant (red, 4s) alongside the
  existing success variant (green, 2s); `showError(message)` is a shorthand.
- Added `socket.on('connect_error', ...)` — previously silent; now shows a one-shot error
  toast (reset on reconnect) rather than leaving live-update loss unexplained.
- Login's raw `fetch()` call (pre-auth, no token yet) was deliberately left as-is — its
  bespoke `showLogin()` banner is the right UX for a full-page pre-auth state, not a toast.

**Tests:** `test-e2e/error-handling.spec.js` — asserts a failed request (insufficient
quantity on deduct) shows a red error toast and never triggers a native `alert()` dialog,
and that a successful request still shows the existing green success toast.

### Issue #9 — password reset / recovery runbook

No in-app reset flow exists for the shared household login (by design — single shared
credential, not per-user accounts), so recovery was previously a manual "regenerate a
bcrypt hash somehow" fire-drill. Added `scripts/generate-password-hash.js` (prints a
bcrypt hash for a given password using the same `bcryptjs` dependency the app already
uses) and a new "Recovery: forgotten household login password" section in `CLAUDE.md`
with the three steps: run the script, set `AUTH_PASSWORD_HASH` on the container, restart.

**Tests:** `test/generate-password-hash.test.js` — runs the script as a child process,
verifies the printed hash both accepts the correct password and rejects a wrong one
(via `bcrypt.compareSync`), and that omitting the password argument exits non-zero.

### Issue #10 — leftover local Docker image cleanup

The leftover `terrible-butler-test:verify` image (373MB, left over from the auth
conversion's container verification) was already gone by the time this sprint reached
it — no `docker rmi` needed. The permission fix (so a future cleanup attempt isn't
blocked by Claude Code's own tooling) could not be applied automatically: the auto-mode
classifier blocks Claude Code from editing its own Bash permission rules, since
self-granting permissions is exactly the kind of action that control exists to catch.
Handed to the user as a manual step: add a narrowly-scoped `permissions.allow` rule for
`docker rmi`/`docker rm` on the `terrible-butler-test` image/container name to
`.claude/settings.local.json` (not a blanket docker allowance — this host runs many
unrelated live containers).

## Sprint summary (2026-08-16 to 2026-08-17)

Six-issue improvement sprint ahead of the React Native migration: #8 (migrations
tracking), #5 (invoice matching + manual-add dedup), #6 (LLM schema validation), #7
(standardised front-end HTTP error handling), #9 (password recovery runbook), #10
(Docker image cleanup — partially resolved, permission fix left to the user). Issue #1
(multi-location inventory) deliberately deferred to its own session — see the sprint
plan note above. Each issue landed on its own feature branch with its own
plan/tests/review cycle, merged to `main` individually; nothing was batched into one
combined branch. Pre-sprint safety net: live DB snapshot at
`inventory-2026-08-17-presprint.db` and the `pre-sprint-2026-08-17` git tag, both still
in place for rollback if needed.

### Issue #1 — inventory in multiple locations

**Context:** deferred from the 2026-08-16/17 sprint as the one genuinely large,
schema-changing item. Today `items` has a single `location_id` and single `quantity`
column — one item can only ever be in one place. This adds a proper many-to-many
item↔location stock model, with the reorder threshold compared against the total across
all locations, and location-tab filtering showing that location's quantity plus how much
exists elsewhere.

**Clarified with the user up front (2026-08-17):**
- Deduct: show an explicit location picker only when the item actually has stock in more
  than one location; skip it (deduct straight from the one location) otherwise.
- "All Inventory" tab: one card per item with its **total** quantity plus a small "+N
  elsewhere" note when multi-location, not one card per item-location pair. Full
  per-location breakdown lives in the details modal.

**Schema (via the #8 migrations runner, `db-migrations.js`):** new `item_locations`
table (`item_id`, `location_id` nullable — mirrors `items.location_id`'s current
nullability for "unassigned" stock, `quantity`), with a partial unique index for
non-null `(item_id, location_id)` pairs and a second partial unique index enforcing at
most one null-location row per item. Added to the base `CREATE TABLE IF NOT EXISTS`
block (fresh installs/tests) **and** as a migration entry that creates the table +
indexes and backfills one row per existing item from its current `location_id`/`quantity`
(guarded against re-insertion — safe to re-run). `items.location_id`/`items.quantity`
are **not** dropped (avoids risky DDL on the populated live table) but become vestigial
after this change, alongside the existing vestigial `inventory` table — noted in
`CLAUDE.md`'s Database notes.

**Backend (`server.js`):** a shared base query (`items.*` plus a `COALESCE(SUM(...))`
total-quantity subquery and a `json_group_array`/`json_object` per-location breakdown
subquery, aliased so the last-column-wins behaviour overrides the stale raw
`items.quantity`) used by `GET /api/items`, `/search`, `/match`, `/barcode/:barcode`,
and the `getItem` helper — each response gains a `locations: [{location_id,
location_name, quantity}]` array. `GET /api/grocery-list` / `/api/out-of-stock-ignored`
filter on the aggregated total, not the raw column. `PATCH /api/items/:id/quantity` and
`POST /api/items/:id/deduct` now take a `location_id` (upsert-into / decrement-from that
specific `item_locations` row; a single-location item infers it automatically if
omitted). `POST /api/items` splits into an identity insert (`items`) + one
`item_locations` row for the chosen initial location. `POST /api/invoices/commit`
inserts/increments `item_locations` rows per line item's `location_id` instead of
`items.quantity`, still updating the in-memory match set from #5. Deleting a location
reassigns its `item_locations` rows to the null-location bucket, merging into an
existing null-location row if the item already has one (avoids the partial-unique-index
collision).

**Frontend (`public/index.html`):** location-tab filtering and quantity display switch
to the `locations` array; item cards show total (+ "elsewhere" note) outside a location
tab, or that location's specific quantity inside one. Quick +/- buttons act directly
when the item has one location; for multi-location items they open the existing qty
modal (extended with a location `<select>`) instead of guessing which location to
adjust — same "explicit picker when ambiguous" principle as deduct. The deduct modal and
barcode-scan-to-deduct flow gain the same location picker, shown only when needed. The
edit modal drops its quantity/location fields (no longer a single value to edit) — stock
changes happen via qty +/-/modal per location; the add modal keeps a single
location+quantity picker for the item's initial stock entry. The details modal gains a
per-location breakdown. Issue #5's manual-add duplicate "Use this" flow now passes the
chosen location through to the quantity-add call.

**Files:** `db-migrations.js`, `item-matching.js` (quantity field now reflects the
aggregate), `server.js` (item query helpers + the endpoints listed above),
`public/index.html` (tabs/cards/qty modal/deduct modal/edit modal/details modal), new
`test/item-locations.test.js`, extensions to `test/invoices.test.js`,
`test/db-migrations.test.js`, and a new `test-e2e/multi-location.spec.js`.

**Pre-change backup:** live DB snapshot + `main` tag before the checkpoint commit, per
CLAUDE.md's pre-change-backup rule for schema changes (same read-only `docker cp`
approach the user authorised during the prior sprint) —
`inventory-2026-08-17-0731-pre-multilocation.db`.

**Two bugs found and fixed during implementation, beyond the original plan:**
- `resolveTargetLocation` initially couldn't distinguish "location omitted from the
  request" (should auto-infer) from "location explicitly sent as `null`/`''`" (should
  target the unassigned bucket) — both fell through the same branch, so an explicit
  request for the unassigned bucket on a multi-location item silently landed on
  whichever location happened to be inferred instead. Caught by a test that passed for
  the wrong reason (single-location item at the time of the assertion, masking the bug);
  fixed and the test strengthened to force a genuine multi-row scenario before asserting.
- `POST /api/invoices/commit`: `existingItems` entries weren't updated after a matched
  item's `lowest_price` changed, so a third line item matching the same item within one
  invoice would compare against a stale lowest price. One-line fix
  (`matchedItem.lowest_price = newLowest`) in the same code path already being edited
  for the location upsert.

**Deviation from the original plan:** used a hand-rolled derived value / partial-index
upsert helper (`upsertItemLocationQuantity`) shared by the quantity/deduct/invoice-commit
endpoints instead of raw `INSERT ... ON CONFLICT` SQL in each call site — simpler to get
right than SQLite's partial-index upsert target syntax, and it's the same helper the
plan's tests already exercise directly.

## 0.16 - 2026-08-16 - Docs: reflect deployed auth model

Docs-only change, no code. `CLAUDE.md` constraints #2 and #8 updated to describe the
now-deployed JWT auth (previously written as "future state" alongside the 0.15 work)
as current fact: NPM was kept in place but its Authentik header/auth settings were
removed, so it's now a plain pass-through in front of the app's own JWT auth. Added a
note that the long-term goal is a React Native rewrite of the front end using this API,
and that issuing the apps — not this auth conversion — is the trigger for the 1.0 MAJOR
bump.

## 0.15 - 2026-08-15 - API + in-app auth conversion

**Context:** step one of the eventual React Native rewrite. Removes Authentik/NPM from
the app's auth path; the app becomes the only gate. Supersedes constraints #2 and #8
from `CLAUDE.md` for this task only; everything else in it (SQLite pragmas, `DB_PATH`,
test seam, LLM model default, camera Permissions-Policy, port binding) is unchanged.

**Route audit:** the app is already almost entirely a JSON `/api/...` backend (28
routes, all JSON — no server-rendered HTML routes exist). "API extraction" therefore
needs no route restructuring, just an auth gate in front of the existing routes, plus
the existing static file serving of `public/` and `/uploads`.

**Design:**
- New env vars: `AUTH_USERNAME`, `AUTH_PASSWORD_HASH` (bcrypt), `JWT_SECRET`.
- `POST /api/auth/login`: checks credentials, returns a JWT (30 day expiry) on success.
  Rate-limited to 5 attempts/15 min per IP using the existing in-memory
  `createRateLimiter` helper already in `server.js` (no new rate-limit dependency).
- `GET /api/health`: new public alias, same body as the existing `/healthz` (which is
  kept as-is, outside `/api`, unauthenticated, for existing monitoring).
- `requireAuth` middleware verifies `Authorization: Bearer <token>` and is mounted on
  `/api` AFTER the login/health routes are registered, so those two stay reachable
  without a token while everything else under `/api` requires one.
- Socket.IO: `io.use(...)` handshake middleware verifies a JWT passed as
  `socket.handshake.auth.token`; unauthenticated sockets are rejected at connect time.
- New deps: `jsonwebtoken` (JWT sign/verify) and `bcryptjs` (pure-JS bcrypt, avoids
  adding another native-compiled dependency alongside better-sqlite3/sharp).
- Frontend: existing (unused) `apiFetch()` helper in `public/index.html` is repurposed
  to attach the `Authorization` header from `localStorage` and to clear the token +
  show a login screen on a 401; the ~19 raw `fetch('/api/...')` call sites are switched
  to call it. A login form overlay is added; the socket client passes the stored token
  via `io({ auth: { token } })` and reconnects with it after login.
- Test-only credentials (vitest `test/setup.js`, Playwright `test-e2e/global-setup.mjs`)
  are fixed, hardcoded, throwaway values distinct from production secrets. Existing
  vitest files call a small `api(app)` wrapper (in `setup.js`) instead of raw
  `request(app)` so every existing test keeps working with a valid token attached.
  Playwright tests get a pre-signed token via `storageState` (page-side) and
  `extraHTTPHeaders` (the `request` fixture) so existing specs don't need per-test
  login flows; one new `test-e2e/auth.spec.js` exercises the real login form logged-out.
- No database schema change.

**Implemented as planned**, plus two fixes discovered along the way:
- `test-e2e/auth-fixtures.mjs` was renamed to `.cjs`: Playwright bundles `.mjs`
  config/setup files through esbuild for static export detection, which proved
  unreliable for a file whose exports are computed at module load (`bcrypt.hashSync`,
  originally `crypto.randomBytes` for `JWT_SECRET`). A plain CommonJS file plus Node's
  native ESM-imports-CJS interop resolved it cleanly.
- That same fixture's `JWT_SECRET` is a fixed string, not randomly generated per run:
  `playwright.config.js` and `test-e2e/global-setup.mjs` load it through separate
  transform contexts, so a value computed with fresh randomness at module-load time
  isn't guaranteed to come out identical in both, and the token minted in config must
  match the secret given to the spawned test server. `AUTH_PASSWORD_HASH` didn't need
  the same fix (bcrypt hashes their own random salt, but only the server's copy is ever
  checked against anything).
- `jsonwebtoken` is used for signing/verifying on the server; the e2e fixture mints its
  token with a small hand-rolled HS256 signer (`node:crypto`) instead of importing
  `jsonwebtoken` directly, for the same esbuild/bundling reason above (`jsonwebtoken`
  pulls in `jws` → `safe-buffer`, which does a conditional `require('buffer')` that
  esbuild's CJS-in-ESM shim can't satisfy). Cross-checked against `jsonwebtoken`'s own
  `verify()` before use.

Full suite green: 39 backend (vitest, incl. 10 new auth tests) + 9 e2e (Playwright,
incl. 2 new login-flow tests) tests. Not yet deployed to production - pending the
port-2627 isolated test-container verification and production secrets.

## 0.14 - 2026-08-11
- Made the location tab bar dynamic instead of hardcoded, in `public/index.html`. Previously the tab bar and its filtering logic were built from a fixed array of location names, so a newly added location never got a tab and renaming/deleting a default location broke its filter.
  - The tab bar now always shows three fixed special tabs (All Inventory, Grocery List, Ignored Out-of-Stock) plus one tab per entry in the `locations` array (from `GET /api/locations`), inserted between All Inventory and Grocery List, in API order.
  - `currentTab` is now a `{ type: 'all' | 'location' | 'grocery' | 'ignored', id }` object rather than a tab-label string; location tabs filter by `item.location_id === currentTab.id` instead of matching `item.location_name` against a hardcoded string, so renames no longer break filtering.
  - The tab bar re-renders whenever `locations` is refetched (initial load and the existing `locations_updated` socket handler), so added/renamed/deleted locations are reflected immediately. If the selected location is deleted, the view falls back to "All Inventory".
  - Added `test-e2e/location-tabs.spec.js`: asserts the three special tabs are always present, that a location seeded via `POST /api/locations` gets its own tab and correctly filters items to that location (and excludes items in other locations), and that renaming/deleting a location updates/removes its tab with a sensible fallback.
  - Scope: `public/index.html` and `test-e2e/` only; `server.js` untouched. Full suite green: 29 backend (vitest) + 7 e2e (Playwright) tests.

## 0.13 - 2026-08-10
- Added a `version` field to the `GET /healthz` response (now `{ status: 'ok', version: '0.13' }`), so a running deployment's version can be verified against this changelog. Updated the backend healthz test to assert on `status` and `version` individually rather than an exact body match.

## 0.12 - 2026-08-10
- Stage 3-lite: graceful shutdown (fixes slow stop), /healthz endpoint, rate limiting, and security headers with camera allowed.

## 0.11 - 2026-08-09
- Stage 2: fixed barcode scanner (context capture), select-before-deduct behavior, XSS escaping; added Playwright e2e suite.

## 0.10 - 2026-08-09
- Stage 1: data-integrity fixes (validation, transactions, guarded deduct, 404s, price recalculation).

## 0.9 - 2026-08-09
- Test harness: Stage 1 red baseline (23 tests).

## 0.8 - 2026-08-09
- Multi-stage build to slim final image (drop compiler toolchain from runtime).

## 0.7 - 2026-08-08
- Added synchronous=FULL pragma for power-loss durability.

## 0.6 - 2026-08-08
- Bumped GitHub Actions to Node 24 versions (checkout v5, login v4, build-push v7).

## 0.5 - 2026-08-08
- Containerised Butler: added Dockerfile, GHCR workflow, dockerignore; externalised LLM config and port.

## 0.4 - 2026-07-26
- Changed server port to 2626 and updated log message.

## 0.3 - 2026-07-26
- Changed page title from 'Household Inventory' to 'Terrible Butler'.

## 0.2 - 2026-07-26
- Removed SQLite WAL files from tracking.

## 0.1 - 2026-07-26
- Initial commit of household inventory app.
