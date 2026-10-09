import { test, expect } from './csp-guard.js';
import path from 'node:path';
import {
  APP_ROOT,
  LOCATION_TAB_BUTTON,
  DEDUCT_OPEN_BUTTON,
  DEDUCT_SEARCH_INPUT,
  DEDUCT_LIST_ITEM,
  DEDUCT_QUANTITY_INPUT,
  DEDUCT_SUBMIT_BUTTON,
  TOAST_NOTIFICATION,
  ADD_OPEN_BUTTON,
  SNAP_LABEL_FILE_INPUT,
  CROP_CONFIRM_BUTTON,
  ITEM_CATEGORY_SELECT,
  CATEGORY_SUGGEST_BLOCK,
  CATEGORY_SUGGEST_SELECT,
} from './testids.js';
import { requestWithRateLimitRetry } from './rateLimitWait.js';

// Coverage ported from the retired legacy front end's specs (error-handling, location-tabs,
// label-scan-suggestion's "close existing category") so it now runs against the React client.

const PRODUCT_IMAGE = path.join(process.cwd(), 'test/fixtures/product1.jpg');

test('a failed request shows a red error toast and no blocking dialog; a successful one shows a green toast', async ({ page, request }) => {
  test.setTimeout(60_000);
  const name = `E2E V2 Toast ${Date.now()}`;
  const created = await requestWithRateLimitRetry(() => request.post('/api/items', { data: { name, quantity: 3 } }));
  expect(created.ok()).toBeTruthy();

  let dialogFired = false;
  page.on('dialog', async (dialog) => {
    dialogFired = true;
    await dialog.dismiss();
  });

  await page.goto('/');
  await page.getByTestId(DEDUCT_OPEN_BUTTON).click();
  await page.getByTestId(DEDUCT_SEARCH_INPUT).fill(name);
  await page.getByTestId(DEDUCT_LIST_ITEM).filter({ hasText: name }).click();
  await page.getByTestId(DEDUCT_QUANTITY_INPUT).fill('5');
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();

  const toast = page.getByTestId(TOAST_NOTIFICATION);
  await expect(toast).toContainText(/insufficient/i);
  await expect(toast).toHaveClass(/bg-red-600/);
  expect(dialogFired).toBe(false);

  await page.getByTestId(DEDUCT_QUANTITY_INPUT).fill('2');
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();
  await expect(toast).toContainText('quantity reduced');
  await expect(toast).toHaveClass(/bg-green-600/);
  expect(dialogFired).toBe(false);

  const items = await (await request.get('/api/items')).json();
  expect(items.find((i) => i.name === name).quantity).toBe(1);
});

test('renaming a location updates its tab live, and deleting the active one falls back to All Inventory', async ({ page, request }) => {
  test.setTimeout(60_000);
  const originalName = `E2E V2 Rename ${Date.now()}`;
  const locRes = await requestWithRateLimitRetry(() => request.post('/api/locations', { data: { name: originalName } }));
  const location = await locRes.json();

  await page.goto('/');
  await expect(page.getByTestId(APP_ROOT)).toHaveAttribute('data-socket-connected', 'true');

  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `name` is a fixed test constant, never user input
  const tab = (name) => page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: new RegExp(`^${name}$`) });
  await tab(originalName).click();
  await expect(tab(originalName)).toHaveClass(/bg-rimmy-purple/);

  const renamedName = `${originalName} Renamed`;
  const renameRes = await requestWithRateLimitRetry(() => request.put(`/api/locations/${location.id}`, { data: { name: renamedName } }));
  expect(renameRes.ok()).toBeTruthy();
  await expect(tab(renamedName)).toHaveCount(1);
  await expect(tab(originalName)).toHaveCount(0);
  await expect(tab(renamedName)).toHaveClass(/bg-rimmy-purple/);

  const deleteRes = await requestWithRateLimitRetry(() => request.delete(`/api/locations/${location.id}`));
  expect(deleteRes.ok()).toBeTruthy();
  await expect(tab(renamedName)).toHaveCount(0);
  await expect(tab('All Inventory')).toHaveClass(/bg-rimmy-purple/);
});

test('label scan: a close existing category is pre-selected and "Use this" does not create a duplicate', async ({ page, request }) => {
  test.setTimeout(60_000);
  const existingName = `E2E V2 Existing Category ${Date.now()}`;
  const existing = await (await requestWithRateLimitRetry(() => request.post('/api/categories', { data: { name: existingName } }))).json();

  await page.route('**/api/parse-label-llm', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Some Product',
        container_details: '',
        category_id: null,
        location_id: null,
        suggested_category_name: `${existingName} Typo`,
        similar_category: { id: existing.id, name: existingName },
        suggested_location_name: null,
        similar_location: null,
      }),
    })
  );

  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(SNAP_LABEL_FILE_INPUT).setInputFiles(PRODUCT_IMAGE);
  await expect(page.getByTestId(CROP_CONFIRM_BUTTON)).toBeEnabled();
  await page.getByTestId(CROP_CONFIRM_BUTTON).click();

  const panel = page.getByTestId(CATEGORY_SUGGEST_BLOCK);
  await expect(panel).toBeVisible();
  await expect(page.getByTestId(CATEGORY_SUGGEST_SELECT)).toHaveValue(String(existing.id));
  await panel.getByRole('button', { name: 'Use this' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(existing.id));

  const cats = await (await request.get('/api/categories')).json();
  expect(cats.filter((c) => c.name.startsWith(existingName))).toHaveLength(1);
});
