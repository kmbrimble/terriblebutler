# Changelog

The minor version (after the dot) is an integer counter that increments by 1 each change: 0.1, 0.2 ... 0.9, 0.10, 0.11, and so on. The major version (before the dot) is NOT auto-incremented — it only advances when the user manually declares a milestone.

## [Unreleased]

### Replace Ollama vision model with Anthropic API (fixes #34)

Dropped the self-hosted Ollama vision model entirely (slow VRAM load time, low
reliability) and call the Anthropic Messages API directly via the official
`@anthropic-ai/sdk`, using forced strict tool-use so the response is guaranteed
schema-valid JSON instead of parsed free-text. Default model `claude-haiku-4-5`
(vision-capable, cheap, fast — matches the issue's stated latency/reliability-over-cost
priority for a synchronous, bounded-schema extraction task), overridable via
`ANTHROPIC_MODEL`. `ANTHROPIC_API_KEY` is read directly from the environment by the
SDK — never hardcoded, logged, or passed through `lib/config.js`.

- `lib/llm-client.js`: remove `fetchWithTimeout`, `fetchWithOllamaFallback`,
  `extractJsonFromText` (Ollama/free-text-specific); add a shared
  `callClaudeForJSON()` helper wrapping `client.messages.create()` with a single
  forced (`tool_choice`), `strict: true` tool. `classifyLineWithLLM` reimplemented
  on top of it, same signature/behaviour (never blocks import on failure).
- `routes/uploads.js` (`/api/parse-label-llm`) and `routes/invoices.js`
  (`/api/invoices/parse`): swap the Ollama-shaped fetch payload for
  `callClaudeForJSON()` calls; existing fallback-on-error behaviour and
  `llm-schema.js` validation/fuzzy-matching untouched.
- `lib/config.js`: remove `getLlmApiUrl()`/`LLM_API_URL`; add
  `getAnthropicModel()` (`ANTHROPIC_MODEL`, default `claude-haiku-4-5`, read live
  like the old `getLlmModel()` for test-override reasons).
- `docker-compose.yml`: drop `LLM_API_URL`, add `ANTHROPIC_API_KEY`.
- No Unraid Community Applications XML template exists anywhere in this repo (only
  `docker-compose.yml`) — the issue assumed one; it's maintained outside this repo,
  so it isn't touched here. The user will add the equivalent field(s) to that
  template themselves.
- Fixed a pre-existing, unrelated bug hit while wiring up `/api/invoices/parse`:
  it called `pdfParse(dataBuffer)` using the `pdf-parse` v1 callable API, but the
  installed v2 replaced that with a `PDFParse` class (already used correctly two
  handlers down, at the `/api/invoices/import` route) — the endpoint was silently
  broken on `main` before this change touched it.
- Tests: new `test/llm-anthropic.test.js` mocks `global.fetch` (the SDK's
  transport) to cover the new Anthropic call path — `callClaudeForJSON`/
  `classifyLineWithLLM` request shape, `/api/parse-label-llm` and
  `/api/invoices/parse` happy-path and failure-path — without hitting the real
  API. `test/invoice-import.test.js`'s unreachable-URL trick moves from
  `LLM_API_URL` to `ANTHROPIC_BASE_URL` (the SDK reads this env var natively).
- `CLAUDE.md` non-negotiable constraint #6 and the `lib/llm-client.js` layout
  entry updated to describe the Anthropic default instead of the retired
  Ollama/granite one.
- Full `npm test` (237 backend + 98 client) green.

## 0.30 - 2026-08-23

### Split server.js into discrete modules (fixes #32)

Pure structural refactor, no behaviour change. `server.js` was a 1512-line file mixing DB
bootstrap, rate limiting, auth, upload config, LLM plumbing, and seven route groups in one
lexical scope; every change, however small, meant reading the whole file. It's now a thin
composition root that wires modules together in a fixed order and re-exports
`{ app, server, db }`.

- New `lib/`: `config.js` (env-derived constants), `database.js` (`openDatabase()` — pragmas,
  schema, migrations, seeding), `realtime.js` (`createRealtime(server, authenticateToken)` —
  resolves the `broadcastUpdate` → `io` → `server` → `app` → routes dependency cycle by taking
  `server` and `authenticateToken` as parameters instead of closing over module-level state),
  `middleware.js` (security headers, rate limiters, multer uploads, `createAuth(db)`),
  `domain-helpers.js` (item shaping/validation), `llm-client.js` (fetch/JSON-extraction/LLM
  classify helpers), `shutdown.js` (`setupGracefulShutdown`).
- New `routes/`: one file per route group — `health`, `auth`, `locations`, `categories`,
  `items`, `price-history`, `uploads`, `invoices` — each exporting a `register*(app, deps)`
  function, called from `server.js` in the exact original mount order.
- Deleted `server.js_prestage1`, a stale leftover from an earlier front-end cutover.
- New `test/module-seam.test.js`: asserts `{ app, server, db }` are still exported and the DB
  opens against `DB_PATH`, and snapshots the full registered route table (method + path, in
  source order) — an empty diff against that snapshot is the strongest signal a future change
  to this area hasn't altered request-handling behaviour.
- `LLM_API_URL`/`LLM_MODEL` are read live from `process.env` at each of the three call sites
  (`routes/uploads.js`, `routes/invoices.js`, `lib/llm-client.js`) via `config.getLlmApiUrl()`/
  `getLlmModel()`, not cached once at module-load time — caching them in `lib/config.js`
  initially broke `test/invoice-import.test.js`, which sets `process.env.LLM_API_URL` in a
  `beforeAll` that runs after `server.js` has already loaded; a code-reviewer pass caught it.
- No schema change, no route path/method/order change, no middleware order change. Full
  `npm test` (231 backend + 98 client) and `npm run test:e2e` (60/60) green.
- A follow-up cleanup pass moved the action-logging middleware and the startup duplicate-barcode
  check out of `server.js` and into `lib/middleware.js` (`actionLogger`) and
  `lib/domain-helpers.js` (`checkDuplicateBarcodes`) respectively, so the composition root has
  no inline middleware or raw SQL left; also dropped two now-dead exports
  (`createRateLimiter`, `openDatabase`'s unused `isFreshDb`).
- `CLAUDE.md`'s non-negotiable constraint list updated to point at the new file layout.

## 0.29 - 2026-08-23

### Long-lived device token auth (fixes #18)

Adds an opt-in second auth path alongside the existing shared-password JWT login, so a
trusted device (kitchen tablet, a phone) can skip re-entering the password after its JWT
expires, without a hard expiry from normal use, and with per-device revocation. Implemented
in parallel in both front ends (`public/index.html` and the React client under `client/`),
since both are live and separately e2e-tested.

- New `device_tokens` table (id, token_hash, device_label, created_at, last_used_at, revoked) —
  brand-new table added directly to `server.js`'s `CREATE TABLE IF NOT EXISTS` block.
- `POST /api/auth/device-token` (requires an existing valid session): generates an opaque random
  token, stores only its SHA-256 hash, returns the raw token once.
- `requireAuth` and the Socket.IO handshake middleware try JWT verification first, then fall back
  to a device-token hash lookup — rejecting a revoked token or one idle for over a year, and
  bumping `last_used_at` on every successful use (sliding expiry).
- `GET /api/auth/devices` and `POST /api/auth/devices/:id/revoke` back a new "Manage Devices"
  panel in the settings drawer of both front ends.
- Both clients reuse the existing `tb_token` localStorage slot for a device token — same header
  format as a JWT, so the rest of each client's request/socket code needs no changes. Each
  login form gets a "remember this device" checkbox + label input that calls the new endpoint
  after a successful login.
- New `test/device-tokens.test.js` (Vitest + supertest) covers issuance, bearer auth via a
  device token, revocation, the 1-year inactivity cutoff, and the device-list/revoke endpoints.
  Full backend suite (227 tests), client unit suite (98 tests), and the Playwright e2e suite
  (60 tests) all pass unchanged.

### Code-review follow-up fixes for #27/#28/#31

An independent review of this session's five issue fixes surfaced three issues, all fixed here:

- **QtyModal silently blocked "Set" for legacy fractional quantities.** #27 changed its amount
  input to `step="1"`, but that input is pre-filled from the item's (or a location's) CURRENT
  quantity — never restricted to whole numbers server-side — so any item with a pre-existing
  fractional quantity would trip native `stepMismatch` on submit with no visible error. Fixed
  by adding `noValidate` to the form and moving the negative-value floor into `handleSubmit`
  (`val < 0` check) instead of relying on native constraint validation for it; `min="0"` still
  clamps the stepper's arrow keys. New e2e test in `test-e2e/v2-item-detail.spec.js` covering
  both a fractional pre-fill saving successfully and a typed negative still being blocked.
- **Homemade/Dog Food category exclusion (#28) was exact-match only.** `category_name` is free
  text with no canonical ID for these two, so "homemade" (lowercase) or "Dog Food " (trailing
  space) silently defeated the exclusion. `filterItems.ts` now trims and lowercases both sides
  before comparing. New unit test in `filterItems.test.ts`.
- **Clarified a misleading code comment in `upsertItemLocationQuantity`'s subtract branch**
  (#31): it described the amount-1 auto-clear-`is_open` rule as tied to "the quick '-' button",
  but the branch is shared by `POST /api/items/:id/deduct` too — a manual deduct of exactly 1
  also clears it, which is deliberate (a data-layer rule, not a UI-specific one) but the
  comment undersold that. Reworded, and added a supertest in `test/item-locations.test.js`
  proving the `/deduct` path exercises the same behaviour.

### Per-location "open" status on items (fixes #31)

Added a per-location `is_open` flag (new `item_locations.is_open INTEGER NOT NULL DEFAULT 0`
column — migration #2 in `db-migrations.js`, guarded by `hasColumn()`, plus the same column
added to the base `CREATE TABLE` for fresh installs) so a household member can mark "there's
an open pack of this at this location". Per-location rather than per-item, since a multi-
location item can have an open pack in one place and a sealed one in another.

- `LOCATIONS_BREAKDOWN_SQL` now includes `is_open` in each `item.locations[]` entry.
- New `PATCH /api/items/:id/open` endpoint (`{ is_open: 0|1, location_id? }`), reusing the
  existing `resolveTargetLocation()` helper for the same "infer when unambiguous, require
  `location_id` when the item has stock in more than one place" rule the quantity endpoints
  already use.
- `upsertItemLocationQuantity()`'s `subtract` branch now also clears `is_open` back to 0 on
  that row whenever the subtracted amount is exactly 1 — this is the data-layer rule for
  "reduced by one auto-clears open", and applies regardless of which UI control triggered it
  (the quick "−" button always subtracts exactly 1; a manual deduct of exactly 1 behaves the
  same way, which is consistent with the rule rather than a special case for it).
- Client: `ItemCard`'s quantity display renders in red when the relevant location's item is
  open (aggregated with "any location open" outside a location tab, mirroring how the qty
  total itself aggregates — see `cardQuantity.ts`'s existing `cardQuantity()`). A new small
  toggle button next to the qty controls sets/clears the flag; it's shown only when the
  target location is unambiguous (inside a location tab, or the item has stock in at most one
  location) — same ambiguity boundary the quick +/- already respects, hidden rather than
  guessed at otherwise.
- New pure helpers `cardIsOpen()` / `openToggleTarget()` in `cardQuantity.ts` with unit tests;
  backend supertest coverage for the new endpoint and the auto-clear-on-subtract-1 rule; a
  migration test for the new column; e2e coverage for the toggle, the red styling, and the
  auto-clear via the quick minus button.

### Items list splits out-of-stock items under an "Unavailable" subheading (fixes #30)

In the "All Inventory" and per-location tabs, `ItemList` now renders in-stock items first,
then an "Unavailable" subheading, then out-of-stock items — each section keeping the user's
chosen sort order rather than the split overriding it. "In stock" is judged per the active
tab: inside a location tab, that location's own quantity (via the existing `cardQuantity()`
helper, already used for the qty +/- display so this reuses that exact per-location number,
not a stale item-wide total); otherwise the item's total across all locations. The Grocery
List and Ignored Out-of-Stock tabs are unaffected — they already have their own
threshold/ignored-flag selection logic, and a qty-based split doesn't make sense stacked on
top of it (every grocery-list item is by definition at or below threshold already).
New `splitAvailability()` pure function added to `cardQuantity.ts` with unit tests, plus an
`ItemList` e2e test covering the split, its per-section sort order, and that Grocery/Ignored
tabs render as one flat list as before.

### Quantity inputs stepped by 1 and floored at 0 (fixes #27)

The reorder-threshold input was already fixed to `step="1" min="0"` in #25. This closes the
same gap on the remaining quantity-style number inputs, which still used `step="0.1"` with no
floor: `ItemFormModal`'s add-mode Quantity field, `DeductModal`'s deduct amount,
`QtyModal`'s set-quantity amount, and `InvoiceImportModal`'s per-line "Qty confirmed". All
four are now `step="1" min="0"`, so the stepper/arrow-keys clamp at 0 and native constraint
validation blocks submitting a typed-in negative value, same UX guard as the threshold fix.
Server-side validation (`finiteNumber(..., { min: 0 })` for quantity/threshold,
`{ min: 0.000001 }` for deduct amount, in `server.js`) already floored these correctly and is
unchanged — no server change needed. New unit tests in `ItemFormModal.test.tsx` (quantity
input) and new test files `DeductModal.test.tsx`, `QtyModal.test.tsx` (step/min addition), and
`InvoiceImportModal.test.tsx`; e2e coverage added to `test-e2e/v2-item-detail.spec.js`
alongside the existing threshold-floor test.

### Homemade and Dog Food items excluded from Grocery List / Ignored tabs (fixes #28)

`filterItems()`'s `'grocery'` and `'ignored'` cases now also require
`item.category_name` not be `'Homemade'` or `'Dog Food'` (exact category name match), on top
of the existing quantity/threshold/ignored-flag checks. These categories aren't
grocery-restockable in the normal sense, so items in them are hidden from both tabs regardless
of stock level — they're unaffected everywhere else (All Inventory, location tabs, search).
New unit tests in `filterItems.test.ts` covering both tabs and both category names, plus
confirming an unrelated category is unaffected.

### Clear button on the search bar (fixes #29)

`SearchInput` gets a small `&times;` clear button on the right, matching the existing modal
close-button convention (`DeductModal`, `ItemFormModal`, etc). Visible only when there's text
in the box; clicking it calls `onChange('')`, which resets `ItemList`'s `search` state and
therefore the filtered list, and refocuses the input. New unit test in a new
`SearchInput.test.tsx` and an e2e addition covering typing text, the button appearing, and
clearing it to restore the unfiltered list.

### Edit quantity per location from the item-detail view (fixes #26)

`ItemDetailModal`'s "Stock by Location" breakdown was read-only. Added a small edit (✎)
button to each row that opens the existing `QtyModal` — the same "set an absolute quantity"
flow already used by the main card's qty display button — pre-scoped to that row's location.
`QtyModal` gained an optional `initialLocationId` prop for this (defaults to the first
location when omitted, so the main card's existing usage is unchanged); since `ItemDetails`
already `extends Item`, the already-fetched `details` object is passed straight through with
no new type or API call needed. Closing the qty modal (save or cancel) re-runs the detail
view's existing `load()`, so the breakdown and the total-stock summary reflect the change
immediately. New unit test in `QtyModal.test.tsx` (new file) covering `initialLocationId`
selection, and an e2e addition to `test-e2e/v2-item-detail.spec.js` proving editing one
location's quantity from the detail view updates only that row and the total.

### Reorder threshold floored at 0 (fixes #25)

`ItemFormModal`'s Reorder Threshold input had no `min` attribute, so the stepper arrows could
step it below 0 and the only guard against a negative value was the server's existing
`finiteNumber(..., { min: 0 })` validation (server.js, item create/update) — which does the
right thing but as a raw 400 error, not a client-side UX guard. Added `min="0"` to the input:
the stepper (and up/down arrow keys) now clamp at 0, and native HTML5 constraint validation
blocks form submission if a negative value is typed in directly, keeping the modal open
instead of round-tripping to the server for a 400. No server change needed — its floor was
already correct and stays as defense in depth for direct API callers. New unit test in
`ItemFormModal.test.tsx` (the `min="0"` attribute is present in both add and edit mode) and
an e2e test in `test-e2e/v2-item-detail.spec.js` covering both the stepper-at-0 case and the
typed-negative-value-blocks-submit case.

### "Save and Add Another" on the add-item modal (fixes #23)

Added a third button, `Save + Add Another`, to `ItemFormModal` — add mode only (hidden when
editing, since "add another" doesn't make sense there). Both it and the existing `Save` button
are `type="submit"` within the same form (so the Name field's native `required` validation
applies to either) and are told apart via `SubmitEvent.submitter`. Submitting via either button
goes through the exact same duplicate-check flow as before (an exact-name match still
auto-merges per #20; other match types still show the confirm panel) — the only difference is
what happens after a successful save: `Save` closes the modal as before, `Save + Add Another`
resets every field back to its add-mode default and keeps the modal open, including when the
save happened via the duplicate-check panel's "Use this"/"Add as new item anyway" (the intent
is carried through `pendingKeepOpen` state since that's a separate, later button click). New
unit tests in `ItemFormModal.test.tsx` (button present in add mode, absent in edit mode) and
an e2e flow in `test-e2e/v2-item-detail.spec.js` covering the real submit → still-open →
second-item → plain-Save-closes sequence.

### Modals lock background scroll while open (fixes #22)

Investigated the reported "opening the add-item modal returns to a previous scroll location"
bug: every modal is conditionally mounted (`{state && <Modal/>}`), so each open is a fresh
mount and any internal `overflow-y-auto` container already starts at scrollTop 0 — the
modal's own content was never the problem. The real cause is that nothing stopped the page
underneath a `fixed inset-0` overlay from still being scrollable: a touch-scroll starting on
the overlay's background scrolls the body behind it, so reopening (or closing) a modal can
visibly jump to whatever scroll position that left behind. Added a shared
`useLockBodyScroll()` hook (`client/src/lib/useLockBodyScroll.ts`) that sets
`document.body.style.overflow = 'hidden'` for as long as a modal is mounted and restores the
previous value on unmount, and called it from all 9 modal components (including the two,
`BarcodeScannerModal`/`CropModal`, that nest inside `ItemFormModal`/`DeductModal` — each
hook instance captures and restores its own mount-time value, so nesting composes correctly).
Not unit-testable (`useEffect`/DOM only, and the client's vitest config runs in a `node`
environment with no DOM) — covered instead by a new Playwright e2e test asserting
`document.body`'s computed `overflow` is `hidden` while a modal is open and reverts on close.

### Location label picks the stocked location, not just the first entry (fixes #21)

`ItemCard`'s single-location label picked `item.locations[0]` unconditionally, so an item
whose `locations` array still carries a stale zero-stock entry (stock moved out, row not
deleted) could show that empty location's name instead of the one that actually has stock.
Extracted the label logic into a new pure helper, `client/src/lib/locationLabel.ts`: when
exactly one location entry has `quantity > 0`, show that one; otherwise fall back to the
original behaviour ("N locations" when there's more than one entry, or the lone entry's name
— even at 0 stock — when there's only one). New unit tests in `locationLabel.test.ts` cover
the stale-entry case, the genuinely-multi-location case, and the all-zero case.

### Auto-add on exact name match (fixes #20)

`ItemFormModal`'s add flow showed the duplicate-check confirmation panel for every match type
returned by `/api/items/match` (barcode, exact_name, fuzzy). An exact case-insensitive name
match is unambiguous, so it now merges into the existing item immediately on submit — same
`updateItemQuantity(..., 'add', ...)` behaviour as clicking "Use this" — with no confirmation
step. Barcode and fuzzy matches are unchanged and still show the panel. Extracted the merge
logic (`mergeQuantityInto`) so both paths share it. Updated the React-client dup-detection
e2e coverage in `test-e2e/v2-item-detail.spec.js` to match (exact-name fixture now auto-merges
without a panel; added a distinct near-but-not-exact name fixture to keep the panel/override
flow covered via a fuzzy match instead). `test-e2e/duplicate-detection.spec.js` targets the
legacy `/legacy/` front end, which is unchanged, so it's left as-is.

### Modal close (X) buttons (fixes #19)

`ItemFormModal`, `ItemDetailModal`, `QtyModal`, and `DeductModal` were the only modals in the
React client without a top-right X close button (5 others — `BarcodeScannerModal`,
`CropModal`, `ManageCategoriesModal`, `ManageLocationsModal`, `InvoiceImportModal` — already
had one). Added the same `&times;` button in a header row for all four, wired to each modal's
existing `onClose`. Bottom Cancel/Save/Close buttons are unchanged. New shared e2e testid
`modal-close-button` and a Playwright test covering all four.

## 0.28 - 2026-08-20

### React client hamburger/settings menu (fixes a post-cutover functional regression)

The 0.27 cutover made the React client the default front end, but no stage ever ported
legacy's hamburger/settings drawer (`public/index.html` L138-198) — it fell outside every
stage's scope (tabs, cards, modals). Investigation via `repository-reader` found this is a
genuine functional regression, not cosmetic: **Manage Categories** (rename/delete), **Manage
Locations** (rename/delete), **Toggle Full Screen**, and a **Dark Mode** switch are completely
unreachable in the React client today (the theme itself persists via `tb_theme`, but there's no
UI control for it). Sort By/Sort Direction/Expanded View are also in legacy's drawer but already
exist inline in the React client (`ItemList.tsx`) — per user decision, these are NOT duplicated
into the new drawer, to avoid two controls for the same state. Legacy's "Upload Invoice" item
(the plain-LLM `/api/invoices/parse`+`/api/invoices/commit` flow) was explicitly deferred out of
React scope in an earlier stage (see 0.26 note on invoice import) and, per explicit user
instruction, is disregarded permanently — not ported, not flagged again. "Import
Coles/Woolworths" reuses the existing `InvoiceImportModal`. Legacy has no logout button, so none
is added.

Changed:
- `client/src/lib/api.ts`: added `updateCategory`/`deleteCategory`/`updateLocation`/
  `deleteLocation`, mirroring the existing `createCategory`/`createLocation` pattern against the
  already-live `PUT`/`DELETE /api/{categories,locations}/:id` backend routes.
- `client/src/lib/theme.ts` (new): `getTheme`/`setTheme`, mirroring `preferences.ts`'s style,
  same `tb_theme` key `client/index.html` already reads pre-paint.
- `client/src/components/MenuDrawer.tsx` (new): hamburger button + slide-in drawer, porting
  legacy's `toggleDrawer()`/`toggleFullScreen()`/`applyTheme()` behaviour exactly.
- `client/src/components/ManageCategoriesModal.tsx` / `ManageLocationsModal.tsx` (new): list +
  add + edit (`window.prompt`) + delete (`window.confirm`), porting `editCategory`/
  `deleteCategory`/`editLocation`/`deleteLocation` from `public/index.html` L864-967 exactly,
  including the same non-blocking delete-while-in-use behaviour and confirmation copy.
- `client/src/components/Header.tsx` / `ItemList.tsx`: wire the hamburger button and new modals
  in following the existing modal-state pattern.
- `test-e2e/testids.js` + new `test-e2e/v2-menu.spec.js`: failing-first e2e coverage for the
  menu button, each drawer item, and the two manage-modals' add/edit/delete flows (legacy itself
  has no test coverage for any of this — confirmed via `repository-reader`).

## 0.27 - 2026-08-20

### React client cutover — default front end moves to `/`

All 6 React rewrite stages are complete and merged; the three known legacy/v2 behavioural gaps
are each resolved or deliberately not ported (see 0.26). This is the point the React client
becomes the default front end — a pure routing swap, no behavioural change to either front end.

- `server.js`: swapped the `express.static` mounts — `client/dist` moves from `/v2` to `/`
  (root), `public/` moves from `/` to `/legacy`. The React client's SPA catch-all is now a
  genuine `app.get('*', ...)` wildcard (it was scoped to `['/v2', '/v2/*']` before), so it was
  moved to the very end of the route table, after every `/api` route, `/healthz`, `/uploads`
  and `/legacy`, so it can't shadow them. One accepted side effect of a root-mounted SPA
  catch-all: a request to a genuinely non-existent path under `/api/*` (a typo, not a real
  endpoint) now falls through to the React client's `index.html` with a 200 instead of a plain
  404 — no existing route or test relies on that default 404, so this doesn't change any
  tested behaviour, but it's a known trade-off of this pattern.
- `client/vite.config.ts`: `base: '/v2/'` → `base: '/'`.
- `client/src`: no hardcoded `/v2` in routing/API code (confirmed via search — the app has no
  client-side router; two stale source comments mentioning `/v2` were reworded for accuracy).
- `test-e2e/`: retargeted existing spec navigation rather than duplicating files — the 6
  `v2-*.spec.js` files' `page.goto('/v2/')` → `page.goto('/')`; the 10 legacy-testing spec
  files' `page.goto('/')` → `page.goto('/legacy/')`. Legacy and v2 specs already share the same
  `data-testid` contract (`test-e2e/testids.js`), so this was a path-only change, no assertion
  rewrites. `playwright.config.js` needed no change (uses a `baseURL` variable, not hardcoded
  paths).
- localStorage keys (`tb_token`, `tb_sort_by`, `tb_sort_dir`, `tb_view_mode`) are already
  identical between both front ends — confirmed by inspection and by the full e2e suite passing
  the login/session flow at both `/` and `/legacy`.
- `/legacy` stays live and unchanged as a one-week manual rollback window (no auto-removal
  logic) — a future task will remove it once the cutover is confirmed stable.
- Bumped `APP_VERSION` in `server.js` (exposed via `/healthz` and `/api/health`) to match.

## 0.26 - 2026-08-20

### React client stage 6 — unified item-detail view

Closes gap #3 of the accumulated legacy/v2 divergence list. Gaps #1 (reorder-threshold step)
and #2 (second invoice-import flow) remain intentionally unaddressed — not reopened here.

Confirmed via `repository-reader` before writing code: legacy's details modal
(`openDetailsModal`/`loadDetailsModal`, `public/index.html` ~L2117-2156) shows category, a
"quantity across N locations" total, container details, barcode, and a stock-by-location
breakdown list, on top of the last/lowest-purchase summary stage 5 already ported. Legacy's
double-tap detection (`handleCardTap`, ~L1000-1018) turned out to be a plain 400ms
same-target-click timer, not touch-coordinate tracking — there was no existing
touchstart/touchend-style gesture code anywhere in the codebase to reuse, and no gesture
library in `client/package.json`.

Replaced `ItemCard`'s standalone "View history" button with a tap-anywhere-on-card
interaction opening a single unified `ItemDetailModal` (renamed from `PriceHistoryModal`) that
combines those legacy fields with stage 5's chart/table/delete, all in one view. Chose native
Pointer Events over a new dependency: `client/src/lib/tapGesture.ts` (framework-free) is one
pure function, `isTap(dx, dy, durationMs)`, true only within ~10px and ~500ms of the
pointerdown start — Pointer Events already unify mouse/touch/pen, so no gesture library earns
its place over a native platform feature plus a few lines. `ItemCard`'s outer element becomes a
`role="button"` div (no existing div-as-button pattern was found in the client, so this is the
first one) wired to `onPointerDown`/`onPointerUp`/`onPointerCancel` (tracks the start point in a
ref, decides via `isTap` on release) and `onKeyDown` (Enter/Space) for keyboard access — a real
`<button>` can't nest the existing qty/edit/ignore buttons. Every nested button gained an
`onPointerDown` guard (`e.stopPropagation()`) alongside its existing `onClick` guard: the card
only starts tracking a gesture on its own pointerdown, so stopping that from bubbling means a
drag that starts on a button never gives the card a start point to compare against, even if the
eventual pointerup bubbles up.

`ItemDetailModal.tsx` adds a category/container/barcode/total-stock grid and a stock-by-location
list ahead of the existing last/lowest-purchase summary, chart, and history table. New testids:
`details-category`, `details-container`, `details-barcode`, `details-total-stock`,
`details-locations-breakdown`, `details-locations-row`. `view-history-button` is removed —
intentional, unlike stage 0's add-only guarantee for markup — and `test-e2e/testids.js` /
`v2-item-detail.spec.js` updated accordingly.

**DEFAULT-vs-NULL fields checked for the newly surfaced data:** reused stage 3's live-DB audit
(already recorded in this changelog) rather than re-querying the live database, per this
project's never-touch-live-DB rule. `category_id`/`category_name` (50/51 live rows NULL) and
`barcode` (49/51 NULL) both fall back to `'-'`, matching legacy's own fallback exactly.
`container_details` (clean live: 0/51 NULL) also falls back to `'-'` for parity with legacy,
though it's a no-op on current live data. `item_locations.quantity` is `REAL NOT NULL DEFAULT 0`
and the breakdown array itself defaults to `[]` server-side (`parseItemLocations`) — never null.

**E2E coverage** (`test-e2e/v2-item-detail.spec.js`): the two existing price-history tests now
tap the card instead of clicking the removed button; new tests cover the unified view showing
category/container/barcode/location-breakdown together with price history in one tap, a
mouse-drag scroll gesture across the card NOT opening the detail view, and a drag starting on
each in-card button (qty −/display/+, edit, ignore/restore) not misfiring the card's tap
detection either. The scroll/drag simulation uses Playwright's mouse API rather than CDP-level
touch injection — mouse down/move/up dispatch through the same Pointer Events pipeline the card
listens on regardless of input device, exercising the exact code path a touch drag would hit.

No server.js/schema/auth changes — `GET /api/items/:id/details` already returned everything the
unified view needed. Full suite green: `npm test` (201 backend + 59 client unit tests, up from
54 with `tapGesture`'s 5 new cases), `npm run test:e2e` (51 Playwright tests, up from 48, every
legacy spec including `card-double-tap.spec.js` still passing unchanged), `npm run build`
(`tsc` clean).

Process note: this stage's branch checkpoint (feature skill Step 4) was created late — after
tests and implementation were already written, not before — because the implementation work
started directly on `main`. No commit had been made to `main` at that point, so `main`'s history
is unaffected; the branch was created retroactively before the first commit, preserving the
guarantee that `main` stays untouched until this stage's own merge.

## 0.25 - 2026-08-20

### React client stage 5 — price history

Confirmed via `repository-reader` before writing code: legacy's price history lives in the
"details modal" (`openDetailsModal`, `public/index.html` ~L2111-2250), reached by a
double-tap/double-click on an item card (single click is reserved for the edit-icon button).
It shows a Chart.js line chart (`GET /api/items/:id/price-history`, filtered to `price > 0`,
oldest→newest) plus a table of every record (date/price/vendor/delete), and a last/lowest
purchase summary sourced from `GET /api/items/:id/details`. Read-only except per-row delete
(`DELETE /api/price-history/:id`, `confirm()`-gated) — history rows are only ever created via
item add/edit or invoice commit, never from this view. All three routes and the schema already
supported this; no server.js/schema changes were needed or made for this stage.

Added a "View history" button to `ItemCard` (parallel to the existing edit button — a plain
click on the card body does nothing in the React client today, unlike legacy, so no double-tap
gesture was needed to disambiguate from editing) opening a new `PriceHistoryModal`. Scope is
price history specifically, per this stage's title: last/lowest purchase summary + chart +
table + delete, reusing the `DETAILS_MODAL`/`DETAILS_TITLE` testids stage 3 already reserved.
The legacy details modal's other fields (category, container, barcode, stock-by-location
breakdown) are a different, out-of-scope feature — not built here. Chart rendering is a small
inline SVG line chart, built from a framework-free `client/src/lib/priceHistoryChart.ts`
(`chartPoints`/`priceExtremes` sort/filter/highlight helpers, unit-tested) rather than adding
`chart.js`/`react-chartjs-2` as a new dependency — same visual information (orange line/area,
purple point markers, red/green max/min row highlighting), no new package for what the SVG
covers directly. `client/src/lib/api.ts` gains `getItemDetails`, `getPriceHistory`,
`deletePriceHistoryEntry`, typed per the live-shaped nullability already established in stage
4's audit: `price_history.price`/`vendor` are typed `number | null`/`string | null` (a REAL
column can genuinely hold NULL on this project's ad-hoc schema history), `recorded_at` is
typed non-null (`DEFAULT CURRENT_TIMESTAMP`, no insert path omits it). E2E coverage extends
`test-e2e/v2-item-detail.spec.js`: one item with three price records (verifies last/lowest
purchase, the chart, all three table rows, and that deleting a row live-updates the modal's
figures) and one item with none (verifies the "No history available" / "N/A" empty state,
not a blank or crashed view). Legacy (`/`) untouched — full suite (`npm test`, 201 backend +
54 client unit tests; `npm run test:e2e`, 48 Playwright tests including every legacy spec)
green.

## 0.24 - 2026-08-20

### React client stage 4 — barcode scanning, label-scan crop, invoice import

Confirmed against `public/index.html` and `server.js` directly via `repository-reader`
(three parallel passes) plus live-DB and dead-code checks before writing any code:

**Barcode scanning.** `html5-qrcode`, used two ways: in the add/edit form, scanning just
fills the barcode text input (no lookup) — the existing stage-3 `matchItem` dup-check on
submit already handles the rest. In deduct, scanning calls `GET /api/items/barcode/:barcode`
directly and selects the item into the deduct flow on a 200, or shows an error on 404
(`Barcode not found in database.`) — it never auto-deducts. Camera teardown on close/cancel.
Port: a `BarcodeScannerModal` wrapping the npm `html5-qrcode` package (legacy loads it from a
CDN global; the client bundles it as a real dependency instead — the two are equivalent for
this project since neither carries React-specific bindings). To keep the existing e2e
seam-stubbing convention (`barcode-scan.spec.js` overrides `window.Html5Qrcode` before the
page loads), the component resolves its constructor as `window.Html5Qrcode ?? (the imported
class)`, so the same stubbing technique from legacy's tests works unchanged for `/v2`.

**Image cropping — divergence from the task's own premise, confirmed not assumed.** Legacy's
crop flow (Cropper.js) is *not* "crop an item photo, then save it" — there is no such feature
in this codebase. It crops a label photo, POSTs the cropped blob to `/api/parse-label-llm`
(the vision LLM), and uses the JSON response to prefill the add/edit form's name, container
details, and category/location (with a fuzzy-match suggestion picker when nothing matches
exactly). Confirmed two ways: grepping `public/index.html` for any caller of
`/api/upload-image` found none (dead route, present in `server.js` but never invoked from the
front end), and a live read-only DB check found `image_path IS NULL` on all 52 live items.
This stage ports the real feature (crop → LLM label parse → form prefill), not the assumed
one; item-photo capture/display is out of scope since it doesn't exist to have parity with.
Port: a `CropModal` wrapping the npm `cropperjs` package the same way — a plain ref-based
DOM library, no React wrapper needed, same reasoning as `html5-qrcode` above. A generic
`SuggestBlock` component replaces `renderSuggestBlock`/`applySuggestion`, reused for both
category and location (legacy's own `SUGGEST_KINDS` map already treats them identically) —
this also gives location suggestion a testid contract for the first time (legacy's
`locationSuggestBlock` has an `id` but no `data-testid`; only category was ever covered by
`label-scan-suggestion.spec.js`). Legacy itself is unmodified.

**Invoice import.** Two *separate* legacy flows exist under this name: a plain LLM
upload+commit flow (`/api/invoices/parse` + `/api/invoices/commit`, client-side-only staging,
no per-line category assignment) and a deterministic Coles/Woolworths parser flow
(`/api/invoices/import`, server-side staging in the `invoice_imports`/`invoice_import_lines`
tables, full per-line review: category, location, quantity, barcode rescan, reviewed/skipped
status, crash-safe resume via `localStorage['tb_active_import_id']`). The task description
("staging list of parsed line items, per-line category assignment, commit to inventory") and
the pre-existing `test-e2e/testids.js` contract (`INVOICE_IMPORT_LINE_CATEGORY_SELECT`,
`INVOICE_IMPORT_SUMMARY_LINE`, etc. — added before this stage, matching only the deterministic
flow's shape) both point at the deterministic flow. This stage ports that one only; the plain
LLM upload+commit flow is out of scope (flagged here, not silently dropped). `CLAUDE.md`'s
"There are no invoice or vendor tables" line was stale — `invoice_imports` and
`invoice_import_lines` exist (currently empty on the live DB, 0 rows each) — corrected as part
of this stage since it was simply wrong, not a design decision that needed a call.

**DEFAULT-vs-NULL fields checked for this stage:** `image_path` (100% NULL live, see above —
not rendered, matching current legacy reachability). `barcode` (51/52 NULL live — already
`string | null` from stage 3, reused as-is by the scan/lookup flow). Invoice line fields
(`matched_item_id`, `suggested_category_id`, `suggested_location_id`, `final_category_id`,
`final_location_id`, `barcode_scanned`, `qty_confirmed`) are all nullable with no live rows to
sample; typed `number | null` / `string | null` and resolved with the same `??` fallback
chains legacy already uses (`final_category_id ?? suggested_category_id`, etc.), which are
null-safe by construction.

**Scope guard confirmed:** no `server.js`, schema, or `public/index.html` changes. Price
history stays out of scope, per the task.

**Tests:** unit tests for the new framework-free `lib/labelScan.ts` (suggestion-picker
branching) and `lib/invoiceImportLine.ts` (value resolution, commit-enabled gate, summary-line
formatting) using constructed objects, not fixtures — 16 new cases. New e2e specs mirroring the
existing legacy ones but targeting `/v2`: barcode add/deduct/not-found (`v2-barcode-scan.spec.js`),
a real end-to-end label-scan (`v2-label-scan.spec.js` — real file input + real Cropper.js UI on
a fixture jpg, mocked `/api/parse-label-llm` response; more thorough than legacy's own test,
which bypasses the crop UI entirely), and invoice import (`v2-invoice-import.spec.js`) using the
same `test/fixtures/invoices/*.pdf` fixtures as the legacy suite, including the
crash-safe-resume-after-reload case.

**Independent review (Step 6.5) found four issues, all fixed before merge:**
1. Camera-start failure (permission denied, no camera) was silently swallowed — legacy shows a
   blocking `alert()` with the error and closes the scanner; `BarcodeScannerModal` now shows a
   non-blocking error toast and closes instead, matching the rest of this stage's error UI.
2. Legacy proactively resumes an in-progress invoice import on every page load
   (`resumeActiveInvoiceImport()`); the initial port only resumed if the user re-opened the
   modal manually. Fixed: `ItemList` now checks `localStorage['tb_active_import_id']` on mount
   and auto-opens `InvoiceImportModal` if set, which then does the real fetch/validation —
   restoring the actual "crash-safe" behaviour the flow is meant to have. (This changed the
   crash-safety and commit e2e tests: they no longer need to click the invoice-import button
   again after a reload, since the modal is already open by then.)
3. No loading indicator during the label-scan LLM parse (legacy shows `#loadingOverlay` for the
   duration of that request); added a small "Reading label…" indicator in `ItemFormModal`.
4. The review agent's own probe (`page.locator('.cropper-crop-box')` in the new e2e spec, to
   wait for Cropper.js's async init) violated `test/e2e-selector-guard.test.js`'s ban on raw CSS
   selectors in `test-e2e/`. Fixed properly rather than just satisfying the guard:
   `CropModal`'s confirm button now stays disabled until Cropper.js has actually initialised
   (it silently no-op'd on an early click before), which is both a real robustness fix and gives
   the e2e spec a testid-based signal (`toBeEnabled()`) to wait on instead.

**Shared e2e mutation-rate-limit budget (see `v2-item-detail.spec.js`'s original diagnosis in
0.22):** this stage's three new spec files pushed the full-suite run over the shared
90-mutations/60s budget again, intermittently 429ing both new and pre-existing specs
non-deterministically depending on run timing. The previous stage's fix (probe headers, wait if
low) turned out not fully reliable under this stage's heavier load — a probe reporting 5
requests of headroom still 429'd on the very next request a few milliseconds later. Replaced
with `test-e2e/rateLimitWait.js`, two helpers: `requestWithRateLimitRetry` retries a mutation
fired through Playwright's `request` fixture against the server's own `RateLimit-Reset` header
after an *actual* 429 (used for the invoice line PATCH loop and category creation), and
`waitForMutationBudget` pre-emptively waits out the window before a UI-driven mutation that
can't be retried after the fact (file uploads, button clicks) — now deliberately conservative
(defaults to requiring 25 of 90 free rather than the smaller margins tried first). Also
surfaced and fixed a second, unrelated flake in the pre-existing `v2-inventory.spec.js`
`locations_updated` test: it fired its mutation as soon as `page.goto()` resolved, but
Socket.IO connects asynchronously after page load — under a full-suite run's heavier load that
gap was wide enough to occasionally fire the mutation before the socket had finished
connecting, missing the broadcast entirely. Fixed by waiting on `App`'s own
`data-socket-connected` attribute before firing the mutation, rather than lengthening the
assertion timeout (tried first; didn't fix the actual race). Confirmed stable across 6
consecutive full `npm run test:e2e` runs after these fixes.

**Tests:** `npm test` — backend 201/201, client unit 48/48 (16 new). `npm run test:e2e` —
46/46 (4 new specs), stable across 6 consecutive full runs.

## 0.23 - 2026-08-19

### Fix: reorder-threshold step in the React item-edit form

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

**Tests:** new `ItemFormModal.test.tsx` case asserting `step="1"` in both add and edit mode.
`v2-item-detail.spec.js`'s edit scenario now drives the threshold via keyboard ArrowUp/Down
(the same native stepping the spinner buttons use) instead of `.fill()`, asserting the
intermediate value after 5 presses is exactly `"5"` and after one more `ArrowDown` is `"4"` —
proving the step size itself, not just that a typed final value saves correctly — then
continues into the existing Grocery-List-tab-appearance assertion unchanged. Confirmed red
against the pre-fix code (5 presses produced `"0.5"`) before applying the fix.

**Tests:** `npm test` — backend 192/192, client unit 32/32 (1 new). `npm run test:e2e` —
36/36, confirmed stable across two consecutive full runs.

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
