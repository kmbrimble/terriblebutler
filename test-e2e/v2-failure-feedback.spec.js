import { test, expect } from './csp-guard.js';
import path from 'node:path';
import {
  ITEM_CARD,
  ADD_OPEN_BUTTON,
  ADD_MODAL,
  ITEM_NAME_INPUT,
  ITEM_QUANTITY_INPUT,
  ITEM_FORM_SUBMIT_BUTTON,
  EDIT_ITEM_BUTTON,
  QTY_PLUS_BUTTON,
  QTY_DISPLAY_BUTTON,
  QTY_MODAL,
  QTY_MODAL_AMOUNT_INPUT,
  QTY_MODAL_LOCATION_SELECT,
  QTY_MODAL_OPEN_TOGGLE,
  QTY_MODAL_SUBMIT_BUTTON,
  OPEN_TOGGLE_BUTTON,
  IGNORE_TOGGLE_BUTTON,
  LOCATION_TAB_BUTTON,
  TOAST_NOTIFICATION,
  SNAP_LABEL_FILE_INPUT,
  CROP_MODAL,
  CROP_CONFIRM_BUTTON,
} from './testids.js';
import { requestWithRateLimitRetry } from './rateLimitWait.js';

// Every async user action must surface a failed request as a toast, leave the dialog open where
// that is the right UX, and never leak an unhandled rejection (csp-guard fails the test on one).
const prefix = `E2E Fail ${Date.now()}`;
// Shares no words with the fixtures, so the duplicate check finds nothing and the save is reached.
const freshName = `Standalone Gizmo Zzq ${Date.now()}`;
let locA, locB, single, multi, grocery;
const FAIL = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated failure' }) };
const failing = (page, glob, method) =>
  page.route(glob, (route) => (route.request().method() === method ? route.fulfill(FAIL) : route.continue()));

test.beforeAll(async ({ request }) => {
  test.setTimeout(90_000);
  const send = async (method, url, data) => {
    const res = await requestWithRateLimitRetry(() => request[method](url, { data }));
    expect(res.ok()).toBeTruthy();
    return res.json();
  };
  locA = await send('post', '/api/locations', { name: `${prefix} A` });
  locB = await send('post', '/api/locations', { name: `${prefix} B` });
  single = await send('post', '/api/items', { name: `${prefix} Single`, location_id: locA.id, quantity: 3 });
  multi = await send('post', '/api/items', { name: `${prefix} Multi`, location_id: locA.id, quantity: 3 });
  await send('patch', `/api/items/${multi.id}/quantity`, { amount: 2, action: 'add', location_id: locB.id });
  grocery = await send('post', '/api/items', { name: `${prefix} Grocery`, location_id: locA.id, quantity: 0, reorder_threshold: 2 });
});

const card = (page, item) => page.getByTestId(ITEM_CARD).filter({ hasText: item.name });
const toast = (page) => page.getByTestId(TOAST_NOTIFICATION);

test('quick +/- button: a failed request shows the server message', async ({ page }) => {
  await failing(page, '**/api/items/*/quantity', 'PATCH');
  await page.goto('/');
  await card(page, single).getByTestId(QTY_PLUS_BUTTON).click();
  await expect(toast(page)).toContainText('Simulated failure');
  await expect(card(page, single).getByTestId(QTY_DISPLAY_BUTTON)).toHaveText('3');
});

test('open and ignore toggles: a failed request shows the server message', async ({ page }) => {
  await failing(page, '**/api/items/*/open', 'PATCH');
  await failing(page, '**/api/items/*/ignore-grocery', 'PATCH');
  await page.goto('/');
  await card(page, single).getByTestId(OPEN_TOGGLE_BUTTON).click();
  await expect(toast(page)).toContainText('Simulated failure');
  await page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' }).click();
  await card(page, grocery).getByTestId(IGNORE_TOGGLE_BUTTON).click();
  await expect(toast(page)).toContainText('Simulated failure');
  await expect(card(page, grocery)).toHaveCount(1);
});

test('set-quantity modal: a failed save shows the message and stays open; a failed open-toggle reverts', async ({ page }) => {
  await failing(page, '**/api/items/*/quantity', 'PATCH');
  await failing(page, '**/api/items/*/open', 'PATCH');
  await page.goto('/');
  await card(page, multi).getByTestId(QTY_DISPLAY_BUTTON).click();
  await expect(page.getByTestId(QTY_MODAL)).toBeVisible();
  await page.getByTestId(QTY_MODAL_LOCATION_SELECT).selectOption(String(locA.id));
  await page.getByTestId(QTY_MODAL_AMOUNT_INPUT).fill('9');
  await page.getByTestId(QTY_MODAL_SUBMIT_BUTTON).click();
  await expect(toast(page)).toContainText('Simulated failure');
  await expect(page.getByTestId(QTY_MODAL)).toBeVisible();
  await expect(page.getByTestId(QTY_MODAL_AMOUNT_INPUT)).toHaveValue('9');

  await page.getByTestId(QTY_MODAL_OPEN_TOGGLE).check();
  await expect(page.getByTestId(QTY_MODAL_OPEN_TOGGLE)).not.toBeChecked();
});

test('add and edit forms: a failed save shows the message and keeps the form (and its input) open', async ({ page }) => {
  await failing(page, '**/api/items', 'POST');
  await failing(page, '**/api/items/*', 'PUT');
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(freshName);
  await page.getByTestId(ITEM_QUANTITY_INPUT).fill('4');
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(toast(page)).toContainText('Simulated failure');
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
  await expect(page.getByTestId(ITEM_NAME_INPUT)).toHaveValue(freshName);
  await page.getByTestId('modal-close-button').click();

  await card(page, single).getByTestId(EDIT_ITEM_BUTTON).click();
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(toast(page)).toContainText('Simulated failure');
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
});

test('add form: a failed duplicate check shows the message and stays open', async ({ page }) => {
  await page.route(/\/api\/items\/match/, (route) => route.fulfill(FAIL));
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(freshName);
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  await expect(toast(page)).toContainText('Simulated failure');
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
});

test('label scan: a failed parse shows a message instead of silently doing nothing', async ({ page }) => {
  await page.route('**/api/parse-label-llm', (route) => route.fulfill(FAIL));
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(SNAP_LABEL_FILE_INPUT).setInputFiles(path.join(process.cwd(), 'test/fixtures/product1.jpg'));
  await expect(page.getByTestId(CROP_MODAL)).toBeVisible();
  await expect(page.getByTestId(CROP_CONFIRM_BUTTON)).toBeEnabled();
  await page.getByTestId(CROP_CONFIRM_BUTTON).click();
  await expect(toast(page)).toContainText(/parse|Simulated failure/i);
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
});

test('duplicate panel: a double-click on "Add as new item anyway" saves exactly once', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/items', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    await new Promise((r) => setTimeout(r, 400));
    return route.continue();
  });
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(ITEM_NAME_INPUT).fill(`${single.name} x`);
  await page.getByTestId(ITEM_FORM_SUBMIT_BUTTON).click();
  const panel = page.getByTestId('dup-check-panel');
  await expect(panel).toBeVisible();
  await panel.getByText('Add as new item anyway').dblclick();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  expect(posts).toBe(1);
});
