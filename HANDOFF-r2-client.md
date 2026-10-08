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
- Other modals' submit handlers lacking try/catch (outside these two flows) were not touched.

## Review
code-diff-reviewer: score 7 (MID), 3 Sonnet + 1 Mythos, all parsed, cost ~US$2.56; counsel offered but skipped — unattended.
One finding (agreement 3/4): `mergeIntoItem` sent a blank location as explicit `null`, creating a phantom
Unassigned bucket on single-location items. Fixed (blank is omitted, server infers; tests added in server,
client unit and e2e). Advisor consulted last.

## Eyeball
Deduct a multi-location item (picker defaults/toast); add an item that triggers "Use this" with a price and
check the item's price history; a blank-location duplicate add on a multi-location item shows the
"location_id is required" toast (wording could be friendlier).
