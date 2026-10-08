# HANDOFF — r2-client (#45, #50)

Branch `security/r2-client`, based on main @ 1bb8eea. No schema change; CHANGELOG/version untouched.

## #45 deduct without a location
- Client: `DeductModal` preselects the only location holding stock (`client/src/lib/deductLocation.ts`),
  otherwise requires a choice (toast "Choose which location to deduct from."). Unassigned has its own
  `<select>` sentinel (`none`), so `''` now only means "nothing chosen" and is never sent.
- Server (`routes/items.js` `/deduct`): a target location with no row answers 409
  "This item has no stock at that location" instead of "Insufficient quantity". Omitted location on a
  multi-location item remains a 400 ("a location_id is required"), now pinned by a test.
- Tests: `test/item-merge-deduct.test.js`, `client/src/lib/deductLocation.test.ts`,
  `test-e2e/v2-duplicate-and-deduct.spec.js`.

## #50 "Use this" discards the purchase record
- New `POST /api/items/:id/merge` (one transaction): add quantity at the location, insert price_history
  row, `recalculateItemPrices`, broadcast `update_quantity`. Same validation as `POST /api/items`.
- Client: `mergeIntoItem` in `api.ts`; both "Use this" and the exact-name auto-merge use it
  (`ItemFormModal.mergeInto`), and failures now show a toast instead of an unhandled rejection.
- `test/module-seam.test.js` route table gains the new route (integration: expect a trivial conflict).
- Tests: server (incl. rollback via temp trigger, atomic bad-price), `api.test.ts`, e2e (barcode "Use this"
  and exact-name auto-merge).

## Fail-before
Server: 5 of 8 new tests failed before the route/message change. e2e: all 4 new specs failed with the old
components, pass now. Client unit: new module absent before.

## Decisions
- `PATCH /quantity` is kept for QtyModal; `/merge` added rather than rewriting shared helpers.
- `lib/domain-helpers.js:144` (shared `resolveTargetLocation`, r2-invoices may touch this file): one-line
  message reword to "This item is stocked in more than one location — choose which one first" (no field name
  in user-facing text). Integrator: check for conflict.
- Visible behaviour change from the review fix: a blank location on "Use this"/exact-name auto-merge against a
  multi-location existing item used to silently land in a phantom Unassigned row; it now returns 400 and the
  toast asks the user to choose.

## Review
code-diff-reviewer: score 7 (MID), 3 Sonnet + 1 Mythos, all parsed, cost ~US$2.56; counsel offered but skipped — unattended.
One finding (agreement 3/4): `mergeIntoItem` sent a blank location as explicit `null`, creating a phantom
Unassigned bucket on single-location items. Fixed (blank is omitted, server infers; tests added in server,
client unit and e2e). Advisor consulted last; its wording fix applied.

## Eyeball
Deduct a multi-location item (picker defaults/toast); add an item that triggers "Use this" with a price and
check the item's price history; a blank-location duplicate add on a multi-location item shows the
"choose which one first" toast.

## Follow-up: failure feedback everywhere + precise `/quantity` errors
**Client audit.** Every async user action now goes through `client/src/lib/actionFeedback.ts`:
`runAction` (returns `{ok}` so the dialog stays open / state reverts on failure), `reportAction`
(fire-and-forget), and `installRejectionToast` (net in `main.tsx` for any handler that forgets). It is silent
when a 401 has just cleared the token (the login redirect is already happening).
Fixed (previously silent or unhandled): quick +/- buttons, ignore and open toggles (`useInventory`), QtyModal
set and open-toggle (reverts), ItemFormModal save/duplicate-check/"Add as new anyway"/"Use this"/label parse,
SuggestBlock create, InvoiceImportModal line patch and resume, CropModal confirm and rebuild.
Already correct and left as is: Login, Manage categories/locations/devices, Deduct, QtyModal move, invoice
cancel/commit/upload, price-history delete, details load, barcode scanner start (own try/catch + toast).
Background socket refetches keep their silent `.catch` (not user actions; `refetchItems` sets the error state).
`matchItem` used to swallow failures and return "no match" (silently skipping duplicate detection); it now throws.
**Real bug found by the new guard:** CropModal's resize rebuild raised `$ready is not a function` as an unhandled
rejection on every label-scan; now waits for `customElements.whenDefined('cropper-image')` and reports failures.
**Review finding fixed:** panel stays up until a save succeeds, so a double-click could POST twice; added an
in-flight guard (`exclusive`) and disabled buttons, with an e2e that double-clicks.
**e2e guard:** `test-e2e/csp-guard.js` (auto fixture, every spec) now also fails on any `unhandledrejection` or
`pageerror`. Failure-injection coverage: `test-e2e/v2-failure-feedback.spec.js` (7 tests). Unit: `actionFeedback.test.ts`,
`api.test.ts` (matchItem). Jsdom is not in this project, so handler classes are covered by e2e plus the helper unit tests.
**`PATCH /quantity` / move-location:** 404 item not found; 400 invalid action (checked before stock, so a bad action
never reads as a stock problem) and ambiguous location; 409 "This item has no stock at that location";
409 "Insufficient quantity" (the old "or item not found" wording is gone). Shared constants and `hasStockRow` in
`routes/items.js`, also used by deduct and move-location. Tests in `test/item-merge-deduct.test.js`.
Review: score 6 (MID), 3 Sonnet + 1 Mythos, none failed; counsel offered but skipped (unattended).
