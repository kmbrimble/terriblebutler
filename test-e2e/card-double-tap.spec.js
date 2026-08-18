import { test, expect } from '@playwright/test';
import { ITEM_CARD, DETAILS_MODAL, DETAILS_TITLE } from './testids.js';

test('a single click on an item card does not open the details modal', async ({ page, request }) => {
  const name = `E2E Single Click ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 1 } });

  await page.goto('/');
  await page.getByTestId(ITEM_CARD).filter({ hasText: name }).click();

  await expect(page.getByTestId(DETAILS_MODAL)).toBeHidden();
});

test('a double click on an item card opens the details modal', async ({ page, request }) => {
  const name = `E2E Double Click ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 1 } });

  await page.goto('/');
  await page.getByTestId(ITEM_CARD).filter({ hasText: name }).dblclick();

  await expect(page.getByTestId(DETAILS_MODAL)).toBeVisible();
  await expect(page.getByTestId(DETAILS_TITLE)).toContainText(name);
});
