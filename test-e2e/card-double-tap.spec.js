import { test, expect } from '@playwright/test';

test('a single click on an item card does not open the details modal', async ({ page, request }) => {
  const name = `E2E Single Click ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 1 } });

  await page.goto('/');
  await page.locator('.item-card', { hasText: name }).click();

  await expect(page.locator('#detailsModal')).toBeHidden();
});

test('a double click on an item card opens the details modal', async ({ page, request }) => {
  const name = `E2E Double Click ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 1 } });

  await page.goto('/');
  await page.locator('.item-card', { hasText: name }).dblclick();

  await expect(page.locator('#detailsModal')).toBeVisible();
  await expect(page.locator('#detailsTitle')).toContainText(name);
});
