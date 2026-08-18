import { test, expect } from '@playwright/test';
import { DEDUCT_OPEN_BUTTON, DEDUCT_SEARCH_INPUT, DEDUCT_LIST_ITEM, DEDUCT_QUANTITY_INPUT, DEDUCT_SUBMIT_BUTTON, TOAST_NOTIFICATION } from './testids.js';

test('a failed request shows an error toast, not a blocking alert dialog', async ({ page, request }) => {
  const name = `E2E Deduct Error ${Date.now()}`;
  const created = await request.post('/api/items', { data: { name, quantity: 1 } });
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
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/insufficient/i);
  await expect(toast).toHaveClass(/bg-red-600/);

  expect(dialogFired).toBe(false);

  const itemsRes = await request.get('/api/items');
  const items = await itemsRes.json();
  expect(items.find((i) => i.name === name).quantity).toBe(1);
});

test('a successful request still shows the (green) success toast', async ({ page, request }) => {
  const name = `E2E Deduct Success ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 5 } });

  await page.goto('/');
  await page.getByTestId(DEDUCT_OPEN_BUTTON).click();
  await page.getByTestId(DEDUCT_SEARCH_INPUT).fill(name);
  await page.getByTestId(DEDUCT_LIST_ITEM).filter({ hasText: name }).click();
  await page.getByTestId(DEDUCT_QUANTITY_INPUT).fill('2');
  await page.getByTestId(DEDUCT_SUBMIT_BUTTON).click();

  const toast = page.getByTestId(TOAST_NOTIFICATION);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('quantity reduced');
  await expect(toast).toHaveClass(/bg-green-600/);
});
