import { test, expect } from '@playwright/test';

test('manual add: an exact-name match offers to reuse the existing item instead of creating a duplicate', async ({ page, request }) => {
  const name = `E2E Dup Item ${Date.now()}`;
  const created = await request.post('/api/items', { data: { name, quantity: 2 } });
  expect(created.ok()).toBeTruthy();
  const existing = await created.json();

  await page.goto('/');
  await page.locator('button[onclick="openAddModal()"]').click();
  await page.locator('#itemName').fill(name);
  await page.locator('#itemQuantity').fill('3');
  await page.locator('#itemForm button[type="submit"]').click();

  const dupPanel = page.locator('#dupCheckPanel');
  await expect(dupPanel).toBeVisible();
  await expect(dupPanel).toContainText('exact name match');

  await dupPanel.getByRole('button', { name: 'Use this' }).click();
  await expect(page.locator('#addModal')).toBeHidden();

  const itemsRes = await request.get('/api/items');
  const items = await itemsRes.json();
  const matches = items.filter((i) => i.name === name);
  expect(matches).toHaveLength(1);
  expect(matches[0].id).toBe(existing.id);
  expect(matches[0].quantity).toBe(5);
});

test('manual add: "Add as new item anyway" overrides a detected match', async ({ page, request }) => {
  const name = `E2E Dup Override ${Date.now()}`;
  await request.post('/api/items', { data: { name, quantity: 1 } });

  await page.goto('/');
  await page.locator('button[onclick="openAddModal()"]').click();
  await page.locator('#itemName').fill(name);
  await page.locator('#itemQuantity').fill('1');
  await page.locator('#itemForm button[type="submit"]').click();

  const dupPanel = page.locator('#dupCheckPanel');
  await expect(dupPanel).toBeVisible();
  await dupPanel.getByText('Add as new item anyway').click();

  await expect(page.locator('#addModal')).toBeHidden();

  const itemsRes = await request.get('/api/items');
  const items = await itemsRes.json();
  expect(items.filter((i) => i.name === name)).toHaveLength(2);
});
