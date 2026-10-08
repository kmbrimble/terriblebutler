import { test, expect } from './csp-guard.js';
import {
  ITEM_CARD,
  ADD_OPEN_BUTTON,
  DEDUCT_OPEN_BUTTON,
  ITEM_NAME_INPUT,
  ITEM_BARCODE_INPUT,
  ITEM_QUANTITY_INPUT,
  ITEM_PRICE_INPUT,
  ITEM_VENDOR_INPUT,
  ITEM_FORM_SUBMIT_BUTTON,
  ADD_MODAL,
  DUP_CHECK_PANEL,
  QTY_DISPLAY_BUTTON,
  DEDUCT_SEARCH_INPUT,
  DEDUCT_LIST_ITEM,
  DEDUCT_LOCATION_SELECT,
  DEDUCT_QUANTITY_INPUT,
  DEDUCT_SUBMIT_BUTTON,
  TOAST_NOTIFICATION,
} from './testids.js';
import { requestWithRateLimitRetry } from './rateLimitWait.js';

// #45 (deduct without choosing a location) and #50 ("Use this" must keep the purchase record).
const prefix = `E2E DupDeduct ${Date.now()}`;
let locA, locB;
let bothStocked, oneStocked, barcodeItem, exactItem;
const barcode = String(Date.now()).slice(-12);

test.beforeAll(async ({ request }) => {
  test.setTimeout(90_000);
  async function send(method, path, data) {
    const res = await requestWithRateLimitRetry(() => request[method](path, { data }));
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  locA = await send('post', '/api/locations', { name: `${prefix} A` });
  locB = await send('post', '/api/locations', { name: `${prefix} B` });
  bothStocked = await send('post', '/api/items', { name: `${prefix} Both`, location_id: locA.id, quantity: 4 });
  await send('patch', `/api/items/${bothStocked.id}/quantity`, { amount: 3, action: 'add', location_id: locB.id });
  oneStocked = await send('post', '/api/items', { name: `${prefix} One`, location_id: locA.id, quantity: 4 });
  await send('patch', `/api/items/${oneStocked.id}/quantity`, { amount: 0, action: 'set', location_id: locB.id });
  barcodeItem = await send('post', '/api/items', { name: `${prefix} Barcoded`, barcode, location_id: locA.id, quantity: 2 });
  exactItem = await send('post', '/api/items', { name: `${prefix} Exact`, location_id: locA.id, quantity: 1 });
});

async function openDeductFor(page, item) {
  await page.goto('/');
  await page.getByTestId(DEDUCT_OPEN_BUTTON).click();
  await page.getByTestId(DEDUCT_SEARCH_INPUT).fill(item.name);
  await page.getByTestId(DEDUCT_LIST_ITEM).filter({ hasText: item.name }).click();
}

const qty = (request, id) => request.get('/api/items').then((r) => r.json()).then((items) => items.find((i) => i.id === id));

test('#45: submitting deduct without picking a location is blocked client-side with an explanation, then works once chosen', async ({ page, request }) => {
  await openDeductFor(page, bothStocked);
  await expect(page.getByTestId(DEDUCT_LOCATION_SELECT)).toHaveValue('');
  await page.getByTestId(DEDUCT_QUANTITY_INPUT).fill('2');
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(TOAST_NOTIFICATION)).toContainText('Choose which location');
  expect((await qty(request, bothStocked.id)).quantity).toBe(7);

  await page.getByTestId(DEDUCT_LOCATION_SELECT).selectOption(String(locB.id));
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(TOAST_NOTIFICATION)).toContainText('Item quantity reduced');
  expect((await qty(request, bothStocked.id)).quantity).toBe(5);
});

test('#45: when only one location has stock it is preselected and deducts without asking', async ({ page, request }) => {
  await openDeductFor(page, oneStocked);
  await expect(page.getByTestId(DEDUCT_LOCATION_SELECT)).toHaveValue(String(locA.id));
  await page.getByTestId(DEDUCT_QUANTITY_INPUT).fill('3');
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(TOAST_NOTIFICATION)).toContainText('Item quantity reduced');
  expect((await qty(request, oneStocked.id)).quantity).toBe(1);
});

test('#50: "Use this" adds the quantity and records the purchase (price, vendor) on the existing item', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(`${prefix} Something Else Entirely`);
  await page.getByTestId(ITEM_BARCODE_INPUT).fill(barcode);
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('3');
  await page.getByTestId(ITEM_PRICE_INPUT).fill('6.5');
  await page.getByTestId(ITEM_VENDOR_INPUT).fill('Corner Shop');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  const panel = page.getByTestId(DUP_CHECK_PANEL);
  await expect(panel).toContainText('barcode match');
  await panel.getByRole('button', { name: 'Use this' }).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: barcodeItem.name }).getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('5');

  const item = await qty(request, barcodeItem.id);
  expect(item.last_price).toBe(6.5);
  expect(item.locations).toHaveLength(1); // no phantom Unassigned bucket
  expect(item.locations[0].quantity).toBe(5);
  const history = await (await request.get(`/api/items/${barcodeItem.id}/price-history`)).json();
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ price: 6.5, vendor: 'Corner Shop' });
});

test('#50: the exact-name auto-merge keeps the purchase record too', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(exactItem.name.toLowerCase());
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('2');
  await page.getByTestId(ITEM_PRICE_INPUT).fill('2.25');
  await page.getByTestId(ITEM_VENDOR_INPUT).fill('Deli');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: exactItem.name }).getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('3');
  const history = await (await request.get(`/api/items/${exactItem.id}/price-history`)).json();
  expect((await qty(request, exactItem.id)).locations).toHaveLength(1);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ price: 2.25, vendor: 'Deli' });
});
