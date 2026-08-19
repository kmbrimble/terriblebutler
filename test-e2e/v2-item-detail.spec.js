import { test, expect } from '@playwright/test';
import {
  ITEM_CARD,
  ADD_OPEN_BUTTON,
  DEDUCT_OPEN_BUTTON,
  ITEM_NAME_INPUT,
  ITEM_LOCATION_SELECT,
  ITEM_QUANTITY_INPUT,
  ITEM_THRESHOLD_INPUT,
  ITEM_FORM_SUBMIT_BUTTON,
  ADD_MODAL,
  DUP_CHECK_PANEL,
  EDIT_ITEM_BUTTON,
  QTY_PLUS_BUTTON,
  QTY_DISPLAY_BUTTON,
  QTY_MODAL,
  QTY_MODAL_AMOUNT_INPUT,
  QTY_MODAL_LOCATION_SELECT,
  QTY_MODAL_SUBMIT_BUTTON,
  IGNORE_TOGGLE_BUTTON,
  LOCATION_TAB_BUTTON,
  DEDUCT_SEARCH_INPUT,
  DEDUCT_LIST_ITEM,
  DEDUCT_LOCATION_SELECT,
  DEDUCT_QUANTITY_INPUT,
  DEDUCT_RESET_BUTTON,
  DEDUCT_SUBMIT_BUTTON,
  VIEW_HISTORY_BUTTON,
  DETAILS_MODAL,
  DETAILS_TITLE,
  DETAILS_LAST_PURCHASE,
  DETAILS_LOWEST_PURCHASE,
  PRICE_CHART,
  PRICE_HISTORY_TABLE_BODY,
  PRICE_HISTORY_ROW,
  PRICE_HISTORY_DELETE_BUTTON,
} from './testids.js';

// Shares the mutationRateLimiter (90/60s)/generalApiRateLimiter (240/60s, GETs included)
// budget with every other spec in the run — see v2-inventory.spec.js's header. Measured: the
// legacy + v2-inventory + v2-login specs alone already consume 87/90 of the mutation budget
// before this file even starts (confirmed by running the suite with this file held out) —
// only ~3 mutations of headroom, nowhere near enough for this file's fixtures, regardless of
// how aggressively they're consolidated. The mutationRateLimiter is a fixed window that resets
// 60s after its bucket's FIRST request of the whole run (createRateLimiter in server.js), and
// every mutation response carries that reset time in the RateLimit-Reset header — so rather
// than guess, this file's beforeAll makes its first mutation, reads that header, and — only if
// the shared budget is actually nearly exhausted — waits out the remainder of the window
// before creating its own fixtures. On an isolated run of just this file (budget nowhere near
// exhausted) this never waits at all. TWO earlier versions of this file hit real 429s besides
// this one (confirmed via [Action] log lines and a saved error-context.md DOM snapshot showing
// an empty, permanently-stuck location <select> — a 429 on the initial GET /api/locations,
// silently swallowed by the client's `.catch(() => {})`; [Action] only logs mutations, never
// GETs, so that one was invisible to a log grep). Also fixed: EVERY mutation made while a page
// is open costs a second, hidden request — the server's socket broadcast triggers ItemList's
// own refetch — so a UI-driven mutation is 2 requests, not 1; fixtures are created in
// beforeAll (no page/socket connected yet, so no refetch penalty) and each test performs only
// the UI-driven mutations its own scenario is actually testing.
const prefix = `E2E Detail ${Date.now()}`;
let locA, locB;
let dupExisting, overrideExisting, editOriginal;
let qtySingle, qtyMulti;
let deductSingle, deductMulti;
let ignoreItem;
let historyItem, noHistoryItem;

test.beforeAll(async ({ request }) => {
  // Default hook timeout (30s) isn't enough if the wait below is needed — the reset can be up
  // to 60s away.
  test.setTimeout(90_000);

  async function post(path, data) {
    const res = await request.post(path, { data });
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  async function patch(path, data) {
    const res = await request.patch(path, { data });
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  async function put(path, data) {
    const res = await request.put(path, { data });
    expect(res.ok()).toBeTruthy();
    return res.json();
  }

  const NEEDED_HEADROOM = 32; // this file's total fixture + UI-driven mutation count, generously rounded
  const probeRes = await request.post('/api/locations', { data: { name: `${prefix} Loc A` } });
  expect(probeRes.ok()).toBeTruthy();
  locA = await probeRes.json();

  const remaining = Number(probeRes.headers()['ratelimit-remaining']);
  const resetAtSeconds = Number(probeRes.headers()['ratelimit-reset']);
  if (Number.isFinite(remaining) && Number.isFinite(resetAtSeconds) && remaining < NEEDED_HEADROOM) {
    const waitMs = Math.max(0, resetAtSeconds * 1000 - Date.now()) + 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  locB = await post('/api/locations', { name: `${prefix} Loc B` });

  dupExisting = await post('/api/items', { name: `${prefix} Dup`, quantity: 2 });
  overrideExisting = await post('/api/items', { name: `${prefix} Override`, quantity: 1 });
  editOriginal = await post('/api/items', { name: `${prefix} Edit`, quantity: 2, location_id: locA.id });

  qtySingle = await post('/api/items', { name: `${prefix} QtySingle`, quantity: 3, location_id: locA.id });
  qtyMulti = await post('/api/items', { name: `${prefix} QtyMulti`, quantity: 3, location_id: locA.id });
  await patch(`/api/items/${qtyMulti.id}/quantity`, { amount: 2, action: 'add', location_id: locB.id });

  deductSingle = await post('/api/items', { name: `${prefix} DeductSingle`, location_id: locA.id, quantity: 5 });
  deductMulti = await post('/api/items', { name: `${prefix} DeductMulti`, location_id: locA.id, quantity: 4 });
  await patch(`/api/items/${deductMulti.id}/quantity`, { amount: 3, action: 'add', location_id: locB.id });

  ignoreItem = await post('/api/items', { name: `${prefix} Ignore`, quantity: 1, reorder_threshold: 2, location_id: locA.id });

  // Three price-history records via one add + two edits, spanning a max (8, most recent) and a
  // min (3) that differ from each other and from the most-recent record, so last-purchase,
  // lowest-purchase, and the row highlighting can each be asserted distinctly.
  historyItem = await post('/api/items', {
    name: `${prefix} History`, quantity: 1, location_id: locA.id, reorder_threshold: 0,
    price: 5, vendor: 'Vendor A', purchase_date: '2026-01-01',
  });
  await put(`/api/items/${historyItem.id}`, {
    name: historyItem.name, reorder_threshold: 0, price: 3, vendor: 'Vendor B', purchase_date: '2026-02-01',
  });
  await put(`/api/items/${historyItem.id}`, {
    name: historyItem.name, reorder_threshold: 0, price: 8, vendor: 'Vendor C', purchase_date: '2026-03-01',
  });

  noHistoryItem = await post('/api/items', { name: `${prefix} NoHistory`, quantity: 1, location_id: locA.id, reorder_threshold: 0 });
});

test('add, duplicate-detect/override, and edit', async ({ page, request }) => {
  await page.goto('/v2/');

  // Add: creates a new item with location, quantity, and reorder threshold. Deliberately
  // shares NO words at all with this file's other fixture names: /api/items/match uses
  // Fuse.js fuzzy search (threshold 0.3) against every existing item's name, and this file's
  // other fixtures all share the "E2E Detail <timestamp> ..." pattern — an earlier attempt
  // that kept "Detail" in this name (`E2E ItemDetailAdd <ts>`) still fuzzy-matched often
  // enough to cause an intermittent failure (confirmed by looping the isolated test ~10
  // times and observing it fail on random-looking runs, traced to the match score sitting
  // close enough to the threshold that it depends on incidental timestamp-digit overlap).
  const addName = `Standalone Widget No Match ${Date.now()}`;
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
  await page.getByTestId(ITEM_NAME_INPUT).fill(addName);
  await page.getByTestId(ITEM_LOCATION_SELECT).selectOption(String(locA.id));
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('3');
  await page.getByTestId(ITEM_THRESHOLD_INPUT).fill('1');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  const addedCard = page.getByTestId(ITEM_CARD).filter({ hasText: addName });
  await expect(addedCard.getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('3');

  // Duplicate detection: an exact-name match (pre-created in beforeAll) offers to reuse the
  // existing item, merging the new quantity into it rather than creating a second row.
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(dupExisting.name);
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('3');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  let dupPanel = page.getByTestId(DUP_CHECK_PANEL);
  await expect(dupPanel).toBeVisible();
  await expect(dupPanel).toContainText('exact name match');
  await dupPanel.getByRole('button', { name: 'Use this' }).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: dupExisting.name }).getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('5');

  // Duplicate override: "Add as new item anyway" creates a second item regardless of the match.
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(overrideExisting.name);
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('1');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  dupPanel = page.getByTestId(DUP_CHECK_PANEL);
  await expect(dupPanel).toBeVisible();
  await dupPanel.getByText('Add as new item anyway').click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: overrideExisting.name })).toHaveCount(2);

  // Edit: location/quantity fields are hidden, and name/category/threshold changes are saved.
  // A reorder_threshold change is verified indirectly via the Grocery List tab (raising the
  // threshold above quantity puts it there) rather than a extra API call — tab filtering is
  // client-side against already-fetched data, so switching tabs costs no server request.
  const editNewName = `${editOriginal.name} Renamed`;
  const editCard = page.getByTestId(ITEM_CARD).filter({ hasText: editOriginal.name });
  await editCard.getByTestId(EDIT_ITEM_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
  await expect(page.getByTestId(ITEM_LOCATION_SELECT)).toBeHidden();
  await expect(page.getByTestId(ITEM_QUANTITY_INPUT)).toBeHidden();
  await page.getByTestId(ITEM_NAME_INPUT).fill(editNewName);
  // Drives the threshold via keyboard stepping (same native stepUp/stepDown the spinner
  // buttons use) rather than .fill(), so this proves the control moves by a whole 1 per
  // press in both directions — not just that *some* final value can be typed in directly.
  const thresholdInput = page.getByTestId(ITEM_THRESHOLD_INPUT);
  await thresholdInput.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
  await expect(thresholdInput).toHaveValue('5');
  await page.keyboard.press('ArrowDown');
  await expect(thresholdInput).toHaveValue('4');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: editNewName })).toHaveCount(1);

  // One combined API check standing in for what the UI already demonstrated, confirming the
  // server-side values exactly rather than just their visible effect.
  const items = await (await request.get('/api/items')).json();
  const created = items.find((i) => i.name === addName);
  expect(created.reorder_threshold).toBe(1);
  const edited = items.find((i) => i.name === editNewName);
  expect(edited.reorder_threshold).toBe(4);
  expect(edited.quantity).toBe(2);
});

test('quantity: quick +/- adjusts directly, targets the active location tab, opens the set-quantity modal when ambiguous, and the display button always opens it directly', async ({ page }) => {
  await page.goto('/v2/');

  // Single-location item, viewed outside any location tab: +/- adjusts directly.
  const singleCard = page.getByTestId(ITEM_CARD).filter({ hasText: qtySingle.name });
  await singleCard.getByTestId(QTY_PLUS_BUTTON).click();
  await expect(singleCard.getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('4');

  // The display button always opens the set-quantity modal directly, regardless of ambiguity,
  // prefilled with the current quantity (single location here, so no location picker).
  await singleCard.getByTestId(QTY_DISPLAY_BUTTON).click();
  await expect(page.getByTestId(QTY_MODAL)).toBeVisible();
  await expect(page.getByTestId(QTY_MODAL_LOCATION_SELECT)).toBeHidden();
  await expect(page.getByTestId(QTY_MODAL_AMOUNT_INPUT)).toHaveValue('4');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId(QTY_MODAL)).toBeHidden();

  // Multi-location item, viewed inside a location tab: +/- adjusts that location directly.
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locA.name }).click();
  const multiCardInTab = page.getByTestId(ITEM_CARD).filter({ hasText: qtyMulti.name });
  await expect(multiCardInTab.getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('3');
  await multiCardInTab.getByTestId(QTY_PLUS_BUTTON).click();
  await expect(multiCardInTab.getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('4');

  // Multi-location item, viewed OUTSIDE a location tab: +/- can't guess which location, so it
  // opens the manual set-quantity modal with a location picker instead of applying a delta.
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'All Inventory' }).click();
  const multiCardAll = page.getByTestId(ITEM_CARD).filter({ hasText: qtyMulti.name });
  await multiCardAll.getByTestId(QTY_PLUS_BUTTON).click();
  await expect(page.getByTestId(QTY_MODAL)).toBeVisible();
  await expect(page.getByTestId(QTY_MODAL_LOCATION_SELECT)).toBeVisible();
  await page.getByTestId(QTY_MODAL_LOCATION_SELECT).selectOption(String(locB.id));
  await page.getByTestId(QTY_MODAL_AMOUNT_INPUT).fill('9');
  await page.getByTestId(QTY_MODAL_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(QTY_MODAL)).toBeHidden();

  // Verify locB's own quantity via that location's tab (client-side filter, no extra request).
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locB.name }).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: qtyMulti.name }).getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('9');
});

test('deduct requires a location picker only for multi-location items, and ignore/restore moves an item between the Grocery and Ignored tabs', async ({ page }) => {
  await page.goto('/v2/');

  await page.getByTestId(DEDUCT_OPEN_BUTTON).click();
  await page.getByTestId(DEDUCT_SEARCH_INPUT).fill(deductSingle.name);
  await page.getByTestId(DEDUCT_LIST_ITEM).filter({ hasText: deductSingle.name }).click();
  await expect(page.getByTestId(DEDUCT_LOCATION_SELECT)).toBeHidden();

  await page.getByTestId(DEDUCT_RESET_BUTTON).click();
  await page.getByTestId(DEDUCT_SEARCH_INPUT).fill(deductMulti.name);
  await page.getByTestId(DEDUCT_LIST_ITEM).filter({ hasText: deductMulti.name }).click();
  await expect(page.getByTestId(DEDUCT_LOCATION_SELECT)).toBeVisible();
  await page.getByTestId(DEDUCT_LOCATION_SELECT).selectOption(String(locB.id));
  await page.getByTestId(DEDUCT_QUANTITY_INPUT).fill('3');
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locB.name }).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: deductMulti.name }).getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('0');

  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();
  const groceryCard = page.getByTestId(ITEM_CARD).filter({ hasText: ignoreItem.name });
  await expect(groceryCard).toHaveCount(1);
  await groceryCard.getByTestId(IGNORE_TOGGLE_BUTTON).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: ignoreItem.name })).toHaveCount(0);

  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Ignored Out-of-Stock' }).click();
  const ignoredCard = page.getByTestId(ITEM_CARD).filter({ hasText: ignoreItem.name });
  await expect(ignoredCard).toHaveCount(1);
  await ignoredCard.getByTestId(IGNORE_TOGGLE_BUTTON).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: ignoreItem.name })).toHaveCount(0);

  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: ignoreItem.name })).toHaveCount(1);
});

test('price history: shows last/lowest purchase, a chart, and a deletable table for an item with recorded prices', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/v2/');
  const card = page.getByTestId(ITEM_CARD).filter({ hasText: historyItem.name });
  await card.getByTestId(VIEW_HISTORY_BUTTON).click();

  const modal = page.getByTestId(DETAILS_MODAL);
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId(DETAILS_TITLE)).toHaveText(historyItem.name);

  // Last purchase = most recent record (Vendor C, $8, Mar); lowest = cheapest overall (Vendor B, $3, Feb).
  await expect(modal.getByTestId(DETAILS_LAST_PURCHASE)).toContainText('$8.00');
  await expect(modal.getByTestId(DETAILS_LAST_PURCHASE)).toContainText('Vendor C');
  await expect(modal.getByTestId(DETAILS_LOWEST_PURCHASE)).toContainText('$3.00');
  await expect(modal.getByTestId(DETAILS_LOWEST_PURCHASE)).toContainText('Vendor B');

  await expect(modal.getByTestId(PRICE_CHART)).toBeVisible();

  const rows = modal.getByTestId(PRICE_HISTORY_TABLE_BODY).getByTestId(PRICE_HISTORY_ROW);
  await expect(rows).toHaveCount(3);

  // Delete the $3 (Vendor B) record; the modal reloads its own data, and the underlying item's
  // last/lowest purchase figures move to what's left (min of the remaining $5 and $8 is $5).
  const rowToDelete = rows.filter({ hasText: 'Vendor B' });
  await rowToDelete.getByTestId(PRICE_HISTORY_DELETE_BUTTON).click();
  await expect(rows).toHaveCount(2);
  await expect(modal.getByTestId(DETAILS_LOWEST_PURCHASE)).toContainText('$5.00');
  await expect(modal.getByTestId(DETAILS_LOWEST_PURCHASE)).toContainText('Vendor A');

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toBeHidden();

  // The item card behind the modal reflects the same deletion (server recalculates
  // last_price/lowest_price, broadcasts inventory_updated, and ItemList refetches).
  await expect(card).toContainText('Lowest: $5.00');
});

test('price history: an item with no recorded prices shows the empty state, not a blank or crashed view', async ({ page }) => {
  await page.goto('/v2/');
  const card = page.getByTestId(ITEM_CARD).filter({ hasText: noHistoryItem.name });
  await card.getByTestId(VIEW_HISTORY_BUTTON).click();

  const modal = page.getByTestId(DETAILS_MODAL);
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId(DETAILS_TITLE)).toHaveText(noHistoryItem.name);
  await expect(modal.getByTestId(DETAILS_LAST_PURCHASE)).toHaveText('N/A');
  await expect(modal.getByTestId(DETAILS_LOWEST_PURCHASE)).toHaveText('N/A');
  await expect(modal.getByTestId(PRICE_HISTORY_TABLE_BODY)).toContainText('No history available');
  await expect(modal.getByTestId(PRICE_HISTORY_ROW)).toHaveCount(0);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toBeHidden();
});
