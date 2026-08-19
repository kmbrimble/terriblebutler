import { test, expect } from '@playwright/test';
import {
  ITEM_CARD,
  ADD_OPEN_BUTTON,
  DEDUCT_OPEN_BUTTON,
  ITEM_NAME_INPUT,
  ITEM_LOCATION_SELECT,
  ITEM_QUANTITY_INPUT,
  ITEM_CATEGORY_SELECT,
  ITEM_THRESHOLD_INPUT,
  ITEM_FORM_SUBMIT_BUTTON,
  ADD_MODAL,
  DUP_CHECK_PANEL,
  EDIT_ITEM_BUTTON,
  QTY_MINUS_BUTTON,
  QTY_PLUS_BUTTON,
  QTY_DISPLAY_BUTTON,
  QTY_MODAL,
  QTY_MODAL_AMOUNT_INPUT,
  QTY_MODAL_LOCATION_SELECT,
  QTY_MODAL_SUBMIT_BUTTON,
  IGNORE_TOGGLE_BUTTON,
  LOCATION_TAB_BUTTON,
  SEARCH_INPUT,
  DEDUCT_SEARCH_INPUT,
  DEDUCT_LIST_ITEM,
  DEDUCT_LOCATION_SELECT,
  DEDUCT_QUANTITY_INPUT,
  DEDUCT_RESET_BUTTON,
  DEDUCT_SUBMIT_BUTTON,
} from './testids.js';

// Shares the same mutationRateLimiter/generalApiRateLimiter budget as v2-inventory.spec.js
// (see that file's header) — only two locations and one category are shared via beforeAll;
// everything else is created per-test so tests stay independent, but kept to the minimum
// mutations each scenario actually needs.

const prefix = `E2E Detail ${Date.now()}`;
let locA, locB;

test.beforeAll(async ({ request }) => {
  async function post(path, data) {
    const res = await request.post(path, { data });
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  locA = await post('/api/locations', { name: `${prefix} Loc A` });
  locB = await post('/api/locations', { name: `${prefix} Loc B` });
});

test('add item: creates a new item with location, quantity, and reorder threshold', async ({ page, request }) => {
  const name = `${prefix} Add ${Date.now()}`;

  await page.goto('/v2/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
  await page.getByTestId(ITEM_NAME_INPUT).fill(name);
  await page.getByTestId(ITEM_LOCATION_SELECT).selectOption(String(locA.id));
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('3');
  await page.getByTestId(ITEM_THRESHOLD_INPUT).fill('1');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();

  const items = await (await request.get('/api/items')).json();
  const created = items.find((i) => i.name === name);
  expect(created).toBeTruthy();
  expect(created.quantity).toBe(3);
  expect(created.reorder_threshold).toBe(1);
  expect(created.locations.find((l) => l.location_id === locA.id).quantity).toBe(3);
});

test('add item: an exact-name match offers to reuse the existing item instead of creating a duplicate', async ({ page, request }) => {
  const name = `${prefix} Dup ${Date.now()}`;
  const existing = await (await request.post('/api/items', { data: { name, quantity: 2 } })).json();

  await page.goto('/v2/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(name);
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('3');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();

  const dupPanel = page.getByTestId(DUP_CHECK_PANEL);
  await expect(dupPanel).toBeVisible();
  await expect(dupPanel).toContainText('exact name match');
  await dupPanel.getByRole('button', { name: 'Use this' }).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();

  const items = await (await request.get('/api/items')).json();
  const matches = items.filter((i) => i.name === name);
  expect(matches).toHaveLength(1);
  expect(matches[0].id).toBe(existing.id);
  expect(matches[0].quantity).toBe(5);
});

test('add item: "Add as new item anyway" overrides a detected match', async ({ page, request }) => {
  const name = `${prefix} DupOverride ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 1 } });

  await page.goto('/v2/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(name);
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('1');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();

  const dupPanel = page.getByTestId(DUP_CHECK_PANEL);
  await expect(dupPanel).toBeVisible();
  await dupPanel.getByText('Add as new item anyway').click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();

  const items = await (await request.get('/api/items')).json();
  expect(items.filter((i) => i.name === name)).toHaveLength(2);
});

test('edit item: location/quantity fields are hidden, and name/category/threshold changes are saved', async ({ page, request }) => {
  const originalName = `${prefix} Edit ${Date.now()}`;
  const newName = `${originalName} Renamed`;
  await request.post('/api/items', { data: { name: originalName, quantity: 2, location_id: locA.id } });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(originalName);
  const card = page.getByTestId(ITEM_CARD).filter({ hasText: originalName });
  await card.getByTestId(EDIT_ITEM_BUTTON).click();

  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
  await expect(page.getByTestId(ITEM_LOCATION_SELECT)).toBeHidden();
  await expect(page.getByTestId(ITEM_QUANTITY_INPUT)).toBeHidden();

  await page.getByTestId(ITEM_NAME_INPUT).fill(newName);
  await page.getByTestId(ITEM_THRESHOLD_INPUT).fill('4');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();

  const items = await (await request.get('/api/items')).json();
  const updated = items.find((i) => i.name === newName);
  expect(updated).toBeTruthy();
  expect(updated.reorder_threshold).toBe(4);
  expect(updated.quantity).toBe(2);
});

test('quantity: quick +/- adjusts directly when unambiguous, targets the active location tab when one is selected, and opens the set-quantity modal when ambiguous', async ({ page, request }) => {
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

  const singleName = `${prefix} QtySingle ${Date.now()}`;
  await post('/api/items', { name: singleName, quantity: 3, location_id: locA.id });

  const multiName = `${prefix} QtyMulti ${Date.now()}`;
  const multiItem = await post('/api/items', { name: multiName, quantity: 3, location_id: locA.id });
  await patch(`/api/items/${multiItem.id}/quantity`, { amount: 2, action: 'add', location_id: locB.id });

  await page.goto('/v2/');

  // Single-location item, viewed outside any location tab: +/- adjusts directly.
  const singleCard = page.getByTestId(ITEM_CARD).filter({ hasText: singleName });
  await singleCard.getByTestId(QTY_PLUS_BUTTON).click();
  await expect(singleCard.getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('4');

  // Multi-location item, viewed inside a location tab: +/- adjusts that location directly.
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locA.name }).click();
  const multiCardInTab = page.getByTestId(ITEM_CARD).filter({ hasText: multiName });
  await expect(multiCardInTab.getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('3');
  await multiCardInTab.getByTestId(QTY_PLUS_BUTTON).click();
  await expect(multiCardInTab.getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('4');

  // Multi-location item, viewed OUTSIDE a location tab: +/- can't guess which location, so it
  // opens the manual set-quantity modal with a location picker instead of applying a delta.
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'All Inventory' }).click();
  const multiCardAll = page.getByTestId(ITEM_CARD).filter({ hasText: multiName });
  await multiCardAll.getByTestId(QTY_PLUS_BUTTON).click();
  await expect(page.getByTestId(QTY_MODAL)).toBeVisible();
  await expect(page.getByTestId(QTY_MODAL_LOCATION_SELECT)).toBeVisible();
  await page.getByTestId(QTY_MODAL_LOCATION_SELECT).selectOption(String(locB.id));
  await page.getByTestId(QTY_MODAL_AMOUNT_INPUT).fill('9');
  await page.getByTestId(QTY_MODAL_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(QTY_MODAL)).toBeHidden();

  const items = await (await request.get('/api/items')).json();
  const updatedMulti = items.find((i) => i.id === multiItem.id);
  expect(updatedMulti.locations.find((l) => l.location_id === locB.id).quantity).toBe(9);
  expect(updatedMulti.locations.find((l) => l.location_id === locA.id).quantity).toBe(4);
});

test('quantity: the display button always opens the set-quantity modal directly, prefilled with the current quantity', async ({ page, request }) => {
  const name = `${prefix} QtyDisplay ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 7, location_id: locA.id } });

  await page.goto('/v2/');
  const card = page.getByTestId(ITEM_CARD).filter({ hasText: name });
  await card.getByTestId(QTY_DISPLAY_BUTTON).click();

  await expect(page.getByTestId(QTY_MODAL)).toBeVisible();
  await expect(page.getByTestId(QTY_MODAL_LOCATION_SELECT)).toBeHidden();
  await expect(page.getByTestId(QTY_MODAL_AMOUNT_INPUT)).toHaveValue('7');
});

test('deduct: shows a location picker only when the item has stock in more than one location', async ({ page, request }) => {
  const singleName = `${prefix} DeductSingle ${Date.now()}`;
  await request.post('/api/items', { data: { name: singleName, location_id: locA.id, quantity: 5 } });

  const multiName = `${prefix} DeductMulti ${Date.now()}`;
  const multiItem = await (await request.post('/api/items', { data: { name: multiName, location_id: locA.id, quantity: 4 } })).json();
  await request.patch(`/api/items/${multiItem.id}/quantity`, { data: { amount: 3, action: 'add', location_id: locB.id } });

  await page.goto('/v2/');
  await page.getByTestId(DEDUCT_OPEN_BUTTON).click();

  await page.getByTestId(DEDUCT_SEARCH_INPUT).fill(singleName);
  await page.getByTestId(DEDUCT_LIST_ITEM).filter({ hasText: singleName }).click();
  await expect(page.getByTestId(DEDUCT_LOCATION_SELECT)).toBeHidden();

  await page.getByTestId(DEDUCT_RESET_BUTTON).click();
  await page.getByTestId(DEDUCT_SEARCH_INPUT).fill(multiName);
  await page.getByTestId(DEDUCT_LIST_ITEM).filter({ hasText: multiName }).click();
  await expect(page.getByTestId(DEDUCT_LOCATION_SELECT)).toBeVisible();

  await page.getByTestId(DEDUCT_LOCATION_SELECT).selectOption(String(locB.id));
  await page.getByTestId(DEDUCT_QUANTITY_INPUT).fill('3');
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();

  const items = await (await request.get('/api/items')).json();
  const updated = items.find((i) => i.id === multiItem.id);
  expect(updated.quantity).toBe(4);
  expect(updated.locations.find((l) => l.location_id === locB.id).quantity).toBe(0);
});

test('ignore/restore: toggling on the Grocery List tab moves the item to Ignored, and back', async ({ page, request }) => {
  const name = `${prefix} Ignore ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 1, reorder_threshold: 2, location_id: locA.id } });

  await page.goto('/v2/');
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();
  const groceryCard = page.getByTestId(ITEM_CARD).filter({ hasText: name });
  await expect(groceryCard).toHaveCount(1);
  await groceryCard.getByTestId(IGNORE_TOGGLE_BUTTON).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: name })).toHaveCount(0);

  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Ignored Out-of-Stock' }).click();
  const ignoredCard = page.getByTestId(ITEM_CARD).filter({ hasText: name });
  await expect(ignoredCard).toHaveCount(1);
  await ignoredCard.getByTestId(IGNORE_TOGGLE_BUTTON).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: name })).toHaveCount(0);

  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: name })).toHaveCount(1);
});
