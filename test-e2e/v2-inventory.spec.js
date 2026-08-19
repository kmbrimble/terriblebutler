import { test, expect } from '@playwright/test';
import {
  APP_ROOT,
  ITEM_CARD,
  ITEM_LIST,
  EMPTY_STATE,
  SEARCH_INPUT,
  SORT_SELECT,
  SORT_DIR_BUTTON,
  VIEW_MODE_TOGGLE,
  LOCATION_TAB_BUTTON,
} from './testids.js';

// The e2e server/DB is shared across every spec file in the run (see global-setup.mjs), so
// every test here gives its fixture items a unique name prefix and filters to it via the
// search box (confirmed to combine with, not replace, the active tab) before asserting order
// or count — this isolates each test's assertions from items created by unrelated specs.

async function createItem(request, overrides = {}) {
  const res = await request.post('/api/items', { data: { name: `E2E Item ${Date.now()}`, quantity: 1, ...overrides } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function createLocation(request, name) {
  const res = await request.post('/api/locations', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function createCategory(request, name) {
  const res = await request.post('/api/categories', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test('the All Inventory tab shows every item', async ({ page, request }) => {
  const prefix = `E2E All ${Date.now()}`;
  await createItem(request, { name: `${prefix} A` });
  await createItem(request, { name: `${prefix} B` });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await expect(page.getByTestId(ITEM_CARD)).toHaveCount(2);
});

test('a location tab shows only items with a matching entry in item.locations[]', async ({ page, request }) => {
  const prefix = `E2E Loc ${Date.now()}`;
  const locA = await createLocation(request, `${prefix} Pantry`);
  const locB = await createLocation(request, `${prefix} Garage`);
  await createItem(request, { name: `${prefix} InA`, location_id: locA.id });
  await createItem(request, { name: `${prefix} InB`, location_id: locB.id });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locA.name }).click();

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(`${prefix} InA`);
});

test('the Grocery List tab shows items at or below their reorder threshold, excluding ignored ones', async ({ page, request }) => {
  const prefix = `E2E Grocery ${Date.now()}`;
  await createItem(request, { name: `${prefix} LowStock`, quantity: 1, reorder_threshold: 2 });
  await createItem(request, { name: `${prefix} WellStocked`, quantity: 5, reorder_threshold: 2 });
  const ignoredItem = await createItem(request, { name: `${prefix} IgnoredLow`, quantity: 0, reorder_threshold: 2 });
  await request.patch(`/api/items/${ignoredItem.id}/ignore-grocery`, { data: { is_ignored_grocery: 1 } });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(`${prefix} LowStock`);
});

test('the Ignored Out-of-Stock tab shows items flagged as ignored', async ({ page, request }) => {
  const prefix = `E2E Ignored ${Date.now()}`;
  const ignoredItem = await createItem(request, { name: `${prefix} Ignored` });
  await request.patch(`/api/items/${ignoredItem.id}/ignore-grocery`, { data: { is_ignored_grocery: 1 } });
  await createItem(request, { name: `${prefix} NotIgnored` });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Ignored Out-of-Stock' }).click();

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(`${prefix} Ignored`);
});

test('search filters by name, combined with the active tab rather than replacing it', async ({ page, request }) => {
  const prefix = `E2E Search ${Date.now()}`;
  const loc = await createLocation(request, `${prefix} Loc`);
  await createItem(request, { name: `${prefix} Chicken Stock`, location_id: loc.id });
  await createItem(request, { name: `${prefix} Beef Stock`, location_id: loc.id });

  await page.goto('/v2/');
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: loc.name }).click();
  await page.getByTestId(SEARCH_INPUT).fill(`${prefix} Chicken`);

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Chicken Stock');
});

test('search filters by barcode, case-insensitively', async ({ page, request }) => {
  const prefix = `E2E Barcode ${Date.now()}`;
  const barcode = `BC${Date.now()}`;
  await createItem(request, { name: `${prefix} Scanned`, barcode });
  await createItem(request, { name: `${prefix} NotScanned` });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(barcode.toLowerCase());

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(`${prefix} Scanned`);
});

test('sorting by name orders correctly in both directions', async ({ page, request }) => {
  const prefix = `E2E SortName ${Date.now()}`;
  await createItem(request, { name: `${prefix} Zebra` });
  await createItem(request, { name: `${prefix} Apple` });
  await createItem(request, { name: `${prefix} Mango` });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(SORT_SELECT).selectOption('name');

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('Apple');
  await expect(cards.nth(1)).toContainText('Mango');
  await expect(cards.nth(2)).toContainText('Zebra');

  await page.getByTestId(SORT_DIR_BUTTON).click();
  await expect(cards.nth(0)).toContainText('Zebra');
  await expect(cards.nth(1)).toContainText('Mango');
  await expect(cards.nth(2)).toContainText('Apple');
});

test('sorting by quantity orders numerically in both directions', async ({ page, request }) => {
  const prefix = `E2E SortQty ${Date.now()}`;
  await createItem(request, { name: `${prefix} High`, quantity: 10 });
  await createItem(request, { name: `${prefix} Low`, quantity: 2 });
  await createItem(request, { name: `${prefix} Mid`, quantity: 5 });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(SORT_SELECT).selectOption('quantity');

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards.nth(0)).toContainText('Low');
  await expect(cards.nth(1)).toContainText('Mid');
  await expect(cards.nth(2)).toContainText('High');

  await page.getByTestId(SORT_DIR_BUTTON).click();
  await expect(cards.nth(0)).toContainText('High');
  await expect(cards.nth(1)).toContainText('Mid');
  await expect(cards.nth(2)).toContainText('Low');
});

test('sorting by category orders by category name in both directions', async ({ page, request }) => {
  const prefix = `E2E SortCat ${Date.now()}`;
  const catA = await createCategory(request, `${prefix} A-Cat`);
  const catM = await createCategory(request, `${prefix} M-Cat`);
  const catZ = await createCategory(request, `${prefix} Z-Cat`);
  await createItem(request, { name: `${prefix} InZ`, category_id: catZ.id });
  await createItem(request, { name: `${prefix} InA`, category_id: catA.id });
  await createItem(request, { name: `${prefix} InM`, category_id: catM.id });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(SORT_SELECT).selectOption('category');

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards.nth(0)).toContainText('InA');
  await expect(cards.nth(1)).toContainText('InM');
  await expect(cards.nth(2)).toContainText('InZ');

  await page.getByTestId(SORT_DIR_BUTTON).click();
  await expect(cards.nth(0)).toContainText('InZ');
  await expect(cards.nth(1)).toContainText('InM');
  await expect(cards.nth(2)).toContainText('InA');
});

test('sorting by location orders by the item\'s first location name in both directions', async ({ page, request }) => {
  const prefix = `E2E SortLoc ${Date.now()}`;
  const locA = await createLocation(request, `${prefix} A-Loc`);
  const locM = await createLocation(request, `${prefix} M-Loc`);
  const locZ = await createLocation(request, `${prefix} Z-Loc`);
  await createItem(request, { name: `${prefix} InZ`, location_id: locZ.id });
  await createItem(request, { name: `${prefix} InA`, location_id: locA.id });
  await createItem(request, { name: `${prefix} InM`, location_id: locM.id });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(SORT_SELECT).selectOption('location');

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards.nth(0)).toContainText('InA');
  await expect(cards.nth(1)).toContainText('InM');
  await expect(cards.nth(2)).toContainText('InZ');

  await page.getByTestId(SORT_DIR_BUTTON).click();
  await expect(cards.nth(0)).toContainText('InZ');
  await expect(cards.nth(1)).toContainText('InM');
  await expect(cards.nth(2)).toContainText('InA');
});

test('sorting by created_at orders by real creation time in both directions', async ({ page, request }) => {
  test.slow();
  const prefix = `E2E SortCreated ${Date.now()}`;
  await createItem(request, { name: `${prefix} First` });
  // SQLite's datetime('now') has second resolution; wait for a real second boundary between
  // creations so created_at genuinely differs, rather than relying on incidental timing.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await createItem(request, { name: `${prefix} Second` });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await createItem(request, { name: `${prefix} Third` });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(SORT_SELECT).selectOption('created_at');

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards.nth(0)).toContainText('First');
  await expect(cards.nth(1)).toContainText('Second');
  await expect(cards.nth(2)).toContainText('Third');

  await page.getByTestId(SORT_DIR_BUTTON).click();
  await expect(cards.nth(0)).toContainText('Third');
  await expect(cards.nth(1)).toContainText('Second');
  await expect(cards.nth(2)).toContainText('First');
});

test('sorting by updated_at orders independently of created_at, in both directions', async ({ page, request }) => {
  test.slow();
  const prefix = `E2E SortUpdated ${Date.now()}`;
  // Created in this order, then touched in the OPPOSITE order, to prove updated_at (not
  // created_at) drives this sort.
  const first = await createItem(request, { name: `${prefix} First` });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await createItem(request, { name: `${prefix} Second` });

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await request.patch(`/api/items/${second.id}/quantity`, { data: { amount: 1, action: 'add' } });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await request.patch(`/api/items/${first.id}/quantity`, { data: { amount: 1, action: 'add' } });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page.getByTestId(SORT_SELECT).selectOption('updated_at');

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Second');
  await expect(cards.nth(1)).toContainText('First');

  await page.getByTestId(SORT_DIR_BUTTON).click();
  await expect(cards.nth(0)).toContainText('First');
  await expect(cards.nth(1)).toContainText('Second');
});

test('sort choice and direction persist across a reload', async ({ page }) => {
  await page.goto('/v2/');
  await page.getByTestId(SORT_SELECT).selectOption('quantity');
  await page.getByTestId(SORT_DIR_BUTTON).click();

  const sortBy = await page.evaluate(() => localStorage.getItem('tb_sort_by'));
  const sortDir = await page.evaluate(() => localStorage.getItem('tb_sort_dir'));
  expect(sortBy).toBe('quantity');
  expect(sortDir).toBe('desc');

  await page.reload();
  await expect(page.getByTestId(SORT_SELECT)).toHaveValue('quantity');
  const sortDirAfterReload = await page.evaluate(() => localStorage.getItem('tb_sort_dir'));
  expect(sortDirAfterReload).toBe('desc');
});

test('view mode toggles between compact and expanded, and the choice is visually reflected', async ({ page, request }) => {
  const prefix = `E2E ViewMode ${Date.now()}`;
  await createItem(request, { name: `${prefix} Item` });

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);

  const card = page.getByTestId(ITEM_CARD).first();
  await expect(card).toHaveAttribute('data-view-mode', 'compact');

  await page.getByTestId(VIEW_MODE_TOGGLE).click();
  await expect(card).toHaveAttribute('data-view-mode', 'expanded');

  const viewMode = await page.evaluate(() => localStorage.getItem('tb_view_mode'));
  expect(viewMode).toBe('expanded');
});

test('a location tab with zero matching items renders an empty state, not an error', async ({ page, request }) => {
  const prefix = `E2E Empty ${Date.now()}`;
  const emptyLoc = await createLocation(request, `${prefix} EmptyLoc`);

  await page.goto('/v2/');
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: emptyLoc.name }).click();

  await expect(page.getByTestId(EMPTY_STATE)).toBeVisible();
  await expect(page.getByTestId(ITEM_CARD)).toHaveCount(0);
  await expect(page.getByTestId(ITEM_LIST)).toBeVisible();
});

test('inventory_updated: a quantity change made via the API in one context is reflected in another without a reload', async ({ page, context, browser, request }) => {
  const prefix = `E2E LiveQty ${Date.now()}`;
  const item = await createItem(request, { name: `${prefix} Item`, quantity: 5 });

  const context2 = await browser.newContext({ storageState: await context.storageState() });
  const page2 = await context2.newPage();

  await page.goto('/v2/');
  await page.getByTestId(SEARCH_INPUT).fill(prefix);
  await page2.goto('/v2/');
  await page2.getByTestId(SEARCH_INPUT).fill(prefix);

  await expect(page.getByTestId(ITEM_CARD).first()).toContainText('5');
  await expect(page2.getByTestId(ITEM_CARD).first()).toContainText('5');

  await request.patch(`/api/items/${item.id}/quantity`, { data: { amount: 3, action: 'add' } });

  await expect(page.getByTestId(ITEM_CARD).first()).toContainText('8');
  await expect(page2.getByTestId(ITEM_CARD).first()).toContainText('8');

  await context2.close();
});

test('locations_updated: a location added via the API in one context appears as a tab in another without a reload', async ({ page, context, browser, request }) => {
  const context2 = await browser.newContext({ storageState: await context.storageState() });
  const page2 = await context2.newPage();

  await page.goto('/v2/');
  await page2.goto('/v2/');

  const locationName = `E2E LiveLoc ${Date.now()}`;
  const res = await request.post('/api/locations', { data: { name: locationName } });
  expect(res.ok()).toBeTruthy();

  await expect(page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locationName })).toHaveCount(1);
  await expect(page2.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locationName })).toHaveCount(1);

  await context2.close();
});
