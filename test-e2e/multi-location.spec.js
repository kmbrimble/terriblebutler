import { test, expect } from '@playwright/test';

test('All Inventory shows the total quantity plus an "elsewhere" note; a location tab shows just that location\'s quantity', async ({ page, request }) => {
  const locA = await (await request.post('/api/locations', { data: { name: `E2E ML Pantry ${Date.now()}` } })).json();
  const locB = await (await request.post('/api/locations', { data: { name: `E2E ML Garage ${Date.now()}` } })).json();
  const name = `E2E Multi-Loc Item ${Date.now()}`;

  const created = await (await request.post('/api/items', { data: { name, location_id: locA.id, quantity: 3 } })).json();
  await request.patch(`/api/items/${created.id}/quantity`, { data: { amount: 2, action: 'add', location_id: locB.id } });

  await page.goto('/');

  const allCard = page.locator('.item-card', { hasText: name });
  await expect(allCard).toContainText('5');
  await expect(allCard).toContainText(/elsewhere/i);

  await page.getByRole('button', { name: locA.name, exact: true }).click();
  const locCard = page.locator('.item-card', { hasText: name });
  await expect(locCard).toContainText('3');
});

test('deduct shows a location picker only when the item has stock in more than one location', async ({ page, request }) => {
  const locA = await (await request.post('/api/locations', { data: { name: `E2E Deduct Single ${Date.now()}` } })).json();
  const singleName = `E2E Single-Loc Deduct ${Date.now()}`;
  await request.post('/api/items', { data: { name: singleName, location_id: locA.id, quantity: 5 } });

  const locB = await (await request.post('/api/locations', { data: { name: `E2E Deduct Multi A ${Date.now()}` } })).json();
  const locC = await (await request.post('/api/locations', { data: { name: `E2E Deduct Multi B ${Date.now()}` } })).json();
  const multiName = `E2E Multi-Loc Deduct ${Date.now()}`;
  const multiItem = await (await request.post('/api/items', { data: { name: multiName, location_id: locB.id, quantity: 4 } })).json();
  await request.patch(`/api/items/${multiItem.id}/quantity`, { data: { amount: 3, action: 'add', location_id: locC.id } });

  await page.goto('/');
  await page.locator('button[onclick="openDeductModal()"]').click();

  await page.locator('#deductSearchInput').fill(singleName);
  await page.locator('#deductList div', { hasText: singleName }).click();
  await expect(page.locator('#deductLocation')).toBeHidden();

  await page.locator('button[onclick="resetDeductModal()"]').click();
  await page.locator('#deductSearchInput').fill(multiName);
  await page.locator('#deductList div', { hasText: multiName }).click();
  await expect(page.locator('#deductLocation')).toBeVisible();

  await page.locator('#deductLocation').selectOption(String(locC.id));
  await page.locator('#deductQuantity').fill('3');
  await page.locator('button[onclick="submitDeduct()"]').click();

  const itemsRes = await request.get('/api/items');
  const items = await itemsRes.json();
  const updated = items.find((i) => i.id === multiItem.id);
  expect(updated.quantity).toBe(4);
  expect(updated.locations.find((l) => l.location_id === locC.id).quantity).toBe(0);
});
