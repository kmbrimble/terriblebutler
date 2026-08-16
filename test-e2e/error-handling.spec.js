import { test, expect } from '@playwright/test';

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
  await page.locator('button[onclick="openDeductModal()"]').click();
  await page.locator('#deductSearchInput').fill(name);
  await page.locator('#deductList div', { hasText: name }).click();
  await page.locator('#deductQuantity').fill('5');
  await page.locator('button[onclick="submitDeduct()"]').click();

  const toast = page.locator('#toastNotification');
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
  await page.locator('button[onclick="openDeductModal()"]').click();
  await page.locator('#deductSearchInput').fill(name);
  await page.locator('#deductList div', { hasText: name }).click();
  await page.locator('#deductQuantity').fill('2');
  await page.locator('button[onclick="submitDeduct()"]').click();

  const toast = page.locator('#toastNotification');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('quantity reduced');
  await expect(toast).toHaveClass(/bg-green-600/);
});
