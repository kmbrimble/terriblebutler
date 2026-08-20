import { test, expect } from '@playwright/test';
import {
  ITEM_CARD,
  ITEM_LIST,
  EMPTY_STATE,
  SEARCH_INPUT,
  SORT_SELECT,
  SORT_DIR_BUTTON,
  VIEW_MODE_TOGGLE,
  LOCATION_TAB_BUTTON,
  APP_ROOT,
} from './testids.js';
import { requestWithRateLimitRetry } from './rateLimitWait.js';

// server.js applies real rate limiters shared across the WHOLE e2e run — a mutationRateLimiter
// (90 POST/PUT/PATCH/DELETE per 60s per IP) and a generalApiRateLimiter (240 /api requests per
// 60s per IP, GETs included) — confirmed in server.js, not something this stage may touch. The
// legacy 24-spec suite alone consumes 69 of the mutation budget, so this file creates fixtures
// ONCE in beforeAll, multi-purposes them heavily (one item often serves several assertions),
// and merges independent read-only checks into as few page.goto() calls as practical (each
// page load costs 3 GETs). Every test still isolates its own assertions from other specs'
// items via a search substring unique to that test's fixture subset.

const prefix = `E2E Inv ${Date.now()}`;

let locA, locZ;
let multiTagItem; // serves the All Inventory, barcode-search, view-mode, and sort/location tests
let sortTagZ;
let groceryLow, groceryIgnored;

test.beforeAll(async ({ request }) => {
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

  locA = await post('/api/locations', { name: `${prefix} A-Loc` });
  locZ = await post('/api/locations', { name: `${prefix} Z-Loc` });
  const catA = await post('/api/categories', { name: `${prefix} A-Cat` });
  const catZ = await post('/api/categories', { name: `${prefix} Z-Cat` });

  multiTagItem = await post('/api/items', {
    name: `${prefix} AllTag SortTag A`,
    quantity: 2,
    location_id: locA.id,
    category_id: catA.id,
    barcode: `BC${Date.now()}`,
  });
  sortTagZ = await post('/api/items', { name: `${prefix} SortTag Z`, quantity: 10, location_id: locZ.id, category_id: catZ.id });

  groceryLow = await post('/api/items', { name: `${prefix} GroTag Low`, quantity: 1, reorder_threshold: 2 });
  groceryIgnored = await post('/api/items', { name: `${prefix} GroTag IgnoredLow`, quantity: 0, reorder_threshold: 2 });
  await patch(`/api/items/${groceryIgnored.id}/ignore-grocery`, { is_ignored_grocery: 1 });
});

// Tab filtering, search (name/barcode/combined-with-tab), view-mode, and the empty state are
// all read-only checks against the beforeAll fixtures — merged into ONE page load (rather than
// one page.goto() per scenario) to keep this file's /api request volume well within the
// server's rate limiter (a real, shared-across-the-whole-suite production safety feature —
// see the file-header comment). Playwright still reports the exact failing line within the
// test if one assertion breaks.
test('tab filtering, search, view-mode, and the empty state', async ({ page }) => {
  await page.goto('/');

  // All Inventory shows every matching item.
  await page.getByTestId(SEARCH_INPUT).fill(`${prefix} AllTag`);
  await expect(page.getByTestId(ITEM_CARD)).toHaveCount(1);

  // A location tab shows only items with a matching entry in item.locations[].
  // "SortTag" alone: multiTagItem is named "... AllTag SortTag A" — "AllTag " sits between
  // the prefix and "SortTag", so a `${prefix} SortTag` substring would not match it.
  await page.getByTestId(SEARCH_INPUT).fill('SortTag');
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locA.name }).click();
  let cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('SortTag A');

  // Search combines with the active tab rather than replacing it: matches an item that
  // exists, but not in this location, then one that does.
  await page.getByTestId(SEARCH_INPUT).fill(`${prefix} SortTag Z`);
  await expect(page.getByTestId(ITEM_CARD)).toHaveCount(0);
  await page.getByTestId(SEARCH_INPUT).fill('SortTag A');
  await expect(page.getByTestId(ITEM_CARD)).toHaveCount(1);

  // The Grocery List tab shows items at or below their reorder threshold, excluding ignored.
  await page.getByTestId(SEARCH_INPUT).fill(`${prefix} GroTag`);
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();
  cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('GroTag Low');

  // The Ignored Out-of-Stock tab shows items flagged as ignored.
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Ignored Out-of-Stock' }).click();
  cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('GroTag IgnoredLow');

  // Search filters by barcode, case-insensitively.
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'All Inventory' }).click();
  await page.getByTestId(SEARCH_INPUT).fill(multiTagItem.barcode.toLowerCase());
  cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('SortTag A');

  // View mode toggles between compact and expanded, and the choice is visually reflected.
  const card = page.getByTestId(ITEM_CARD).first();
  await expect(card).toHaveAttribute('data-view-mode', 'compact');
  await page.getByTestId(VIEW_MODE_TOGGLE).click();
  await expect(card).toHaveAttribute('data-view-mode', 'expanded');
  expect(await page.evaluate(() => localStorage.getItem('tb_view_mode'))).toBe('expanded');

  // A location tab with zero matching items renders an empty state, not an error.
  await page.getByTestId(SEARCH_INPUT).fill('');
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locZ.name }).click();
  // sortTagZ lives in locZ, so search for something that can't match it to reach zero results.
  await page.getByTestId(SEARCH_INPUT).fill('NoSuchItemXYZ');
  await expect(page.getByTestId(EMPTY_STATE)).toBeVisible();
  await expect(page.getByTestId(ITEM_CARD)).toHaveCount(0);
  await expect(page.getByTestId(ITEM_LIST)).toBeVisible();
});

test('sorting by name, quantity, category, and location all order correctly in both directions', async ({ page }) => {
  // multiTagItem ("...A") and sortTagZ ("...Z") were deliberately given a matching A < Z
  // relative order across all four fields (name, quantity 2 < 10, category A-Cat < Z-Cat,
  // location A-Loc < Z-Loc) so this one fixture pair proves all four sort keys.
  await page.goto('/');
  await page.getByTestId(SEARCH_INPUT).fill('SortTag');
  const cards = page.getByTestId(ITEM_CARD);

  for (const sortBy of ['name', 'quantity', 'category', 'location']) {
    await page.getByTestId(SORT_SELECT).selectOption(sortBy);
    await expect(cards.nth(0)).toContainText('SortTag A');
    await expect(cards.nth(1)).toContainText('SortTag Z');
  }

  await page.getByTestId(SORT_DIR_BUTTON).click();
  for (const sortBy of ['name', 'quantity', 'category', 'location']) {
    await page.getByTestId(SORT_SELECT).selectOption(sortBy);
    await expect(cards.nth(0)).toContainText('SortTag Z');
    await expect(cards.nth(1)).toContainText('SortTag A');
  }
});

test('sorting by created_at and updated_at order by real timestamps, independently, in both directions', async ({ page, request }) => {
  test.slow();
  const timePrefix = `${prefix} SortTime`;
  const firstRes = await request.post('/api/items', { data: { name: `${timePrefix} First`, quantity: 1 } });
  expect(firstRes.ok()).toBeTruthy();
  const first = await firstRes.json();
  // SQLite's datetime('now') has second resolution; wait for a real second boundary between
  // creations so created_at genuinely differs, rather than relying on incidental timing.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const secondRes = await request.post('/api/items', { data: { name: `${timePrefix} Second`, quantity: 1 } });
  expect(secondRes.ok()).toBeTruthy();
  const second = await secondRes.json();

  await page.goto('/');
  await page.getByTestId(SEARCH_INPUT).fill(timePrefix);
  await page.getByTestId(SORT_SELECT).selectOption('created_at');

  const cards = page.getByTestId(ITEM_CARD);
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('First');
  await expect(cards.nth(1)).toContainText('Second');

  await page.getByTestId(SORT_DIR_BUTTON).click(); // now desc
  await expect(cards.nth(0)).toContainText('Second');
  await expect(cards.nth(1)).toContainText('First');

  // Touch them in the OPPOSITE order, with real gaps, to prove updated_at (not created_at)
  // drives this sort — and to prove it's independent of the created_at sort above.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await request.patch(`/api/items/${second.id}/quantity`, { data: { amount: 1, action: 'add' } });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await request.patch(`/api/items/${first.id}/quantity`, { data: { amount: 1, action: 'add' } });

  await page.getByTestId(SORT_SELECT).selectOption('updated_at'); // still desc from above
  await expect(cards.nth(0)).toContainText('First');
  await expect(cards.nth(1)).toContainText('Second');

  await page.getByTestId(SORT_DIR_BUTTON).click(); // now asc
  await expect(cards.nth(0)).toContainText('Second');
  await expect(cards.nth(1)).toContainText('First');
});

test('sort choice and direction persist across a reload', async ({ page }) => {
  await page.goto('/');
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

test('inventory_updated: a quantity change made via the API in one context is reflected in another without a reload', async ({
  page,
  context,
  browser,
  request,
}) => {
  const itemRes = await request.post('/api/items', { data: { name: `${prefix} LiveQty Item`, quantity: 5 } });
  expect(itemRes.ok()).toBeTruthy();
  const item = await itemRes.json();

  const context2 = await browser.newContext({ storageState: await context.storageState() });
  const page2 = await context2.newPage();

  await page.goto('/');
  await page.getByTestId(SEARCH_INPUT).fill(`${prefix} LiveQty`);
  await page2.goto('/');
  await page2.getByTestId(SEARCH_INPUT).fill(`${prefix} LiveQty`);

  await expect(page.getByTestId(ITEM_CARD).first()).toContainText('5');
  await expect(page2.getByTestId(ITEM_CARD).first()).toContainText('5');

  await request.patch(`/api/items/${item.id}/quantity`, { data: { amount: 3, action: 'add' } });

  await expect(page.getByTestId(ITEM_CARD).first()).toContainText('8');
  await expect(page2.getByTestId(ITEM_CARD).first()).toContainText('8');

  await context2.close();
});

test('locations_updated: a location added via the API in one context appears as a tab in another without a reload', async ({
  page,
  context,
  browser,
  request,
}) => {
  test.setTimeout(60_000);
  const context2 = await browser.newContext({ storageState: await context.storageState() });
  const page2 = await context2.newPage();

  await page.goto('/');
  await page2.goto('/');

  // Socket.IO connects asynchronously after the page loads (App.tsx's connectSocket() runs in
  // a useEffect gated on the auth check resolving) — firing the mutation before both sockets
  // have actually finished connecting means the server broadcast has nothing to reach on that
  // page, and the assertion below would then wait forever for an event that already happened.
  // Under a full-suite run's shared server load this gap is wide enough to hit intermittently;
  // waiting for App's own data-socket-connected flag closes it properly instead of guessing at
  // a longer timeout.
  await expect(page.getByTestId(APP_ROOT)).toHaveAttribute('data-socket-connected', 'true');
  await expect(page2.getByTestId(APP_ROOT)).toHaveAttribute('data-socket-connected', 'true');

  const locationName = `${prefix} LiveLoc`;
  const res = await requestWithRateLimitRetry(() => request.post('/api/locations', { data: { name: locationName } }));
  expect(res.ok()).toBeTruthy();

  await expect(page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locationName })).toHaveCount(1);
  await expect(page2.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locationName })).toHaveCount(1);

  await context2.close();
});
