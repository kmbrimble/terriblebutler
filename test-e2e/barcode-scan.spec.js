import { test, expect } from '@playwright/test';

async function stubScanner(page) {
  await page.route('**/html5-qrcode**', route => route.abort());
  await page.addInitScript(() => {
    window.__scanSuccess = null;
    window.Html5Qrcode = class {
      constructor() {}
      async start(camera, config, onSuccess) {
        window.__scanSuccess = onSuccess;
      }
      async stop() {}
    };
  });
}

test('scanning a barcode in Add context populates the barcode field', async ({ page }) => {
  await stubScanner(page);
  await page.goto('/');

  await page.evaluate(() => window.openAddModal());
  await page.evaluate(() => window.openBarcodeScanner('add'));
  await page.evaluate(() => window.__scanSuccess('9310598500211'));

  await expect(page.locator('#itemBarcode')).toHaveValue('9310598500211');
});

test('scanning a barcode in Deduct context selects the item without immediately deducting', async ({ page }) => {
  await stubScanner(page);

  let deductCalled = false;
  await page.route('**/api/items/barcode/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 42, name: 'Test Item', location_id: 3 })
  }));
  await page.route('**/api/items/42/deduct', route => {
    deductCalled = true;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 42, name: 'Test Item', quantity: 4 })
    });
  });

  await page.goto('/');

  await page.evaluate(() => window.openDeductModal());
  await page.evaluate(() => window.openBarcodeScanner('deduct'));
  await page.evaluate(() => window.__scanSuccess('9310598500211'));

  await expect(page.locator('#deductActionContainer')).toBeVisible();
  await expect(page.locator('#deductItemId')).toHaveValue('42');
  expect(deductCalled).toBe(false);
});
