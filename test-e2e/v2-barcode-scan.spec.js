import { test, expect } from '@playwright/test';
import {
  ADD_OPEN_BUTTON,
  DEDUCT_OPEN_BUTTON,
  BARCODE_SCAN_BUTTON,
  ITEM_BARCODE_INPUT,
  DEDUCT_ACTION_CONTAINER,
  TOAST_NOTIFICATION,
} from './testids.js';

// Mirrors test-e2e/barcode-scan.spec.js's stubbing approach, adapted for the bundled npm
// html5-qrcode package: BarcodeScannerModal resolves its constructor as
// `window.Html5Qrcode ?? (the imported class)`, so overriding window.Html5Qrcode before the
// page loads intercepts it exactly the same way legacy's CDN-global override does.
async function stubScanner(page) {
  await page.addInitScript(() => {
    window.__scanSuccess = null;
    window.Html5Qrcode = class {
      constructor() {}
      async start(camera, config, onSuccess) {
        window.__scanSuccess = onSuccess;
        return null;
      }
      async stop() {}
    };
  });
}

test('v2: scanning a barcode in the add form populates the barcode field', async ({ page }) => {
  await stubScanner(page);
  await page.goto('/');

  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(BARCODE_SCAN_BUTTON).click();
  await page.waitForFunction(() => window.__scanSuccess !== null);
  await page.evaluate((barcode) => window.__scanSuccess(barcode), '9310598500211');

  await expect(page.getByTestId(ITEM_BARCODE_INPUT)).toHaveValue('9310598500211');
});

test('v2: scanning a barcode in the deduct form selects the matched item without deducting', async ({ page }) => {
  await stubScanner(page);

  let deductCalled = false;
  await page.route('**/api/items/barcode/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 42, name: 'Test Item', quantity: 4, locations: [] }),
    })
  );
  await page.route('**/api/items/42/deduct', (route) => {
    deductCalled = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 42, name: 'Test Item', quantity: 4 }) });
  });

  await page.goto('/');
  await page.getByTestId(DEDUCT_OPEN_BUTTON).click();
  await page.getByTestId(BARCODE_SCAN_BUTTON).click();
  await page.waitForFunction(() => window.__scanSuccess !== null);
  await page.evaluate((barcode) => window.__scanSuccess(barcode), '9310598500211');

  await expect(page.getByTestId(DEDUCT_ACTION_CONTAINER)).toBeVisible();
  await expect(page.getByText('Test Item')).toBeVisible();
  expect(deductCalled).toBe(false);
});

test('v2: scanning an unknown barcode in the deduct form shows an error toast and does not select anything', async ({ page }) => {
  await stubScanner(page);
  await page.route('**/api/items/barcode/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Item not found' }) }));

  await page.goto('/');
  await page.getByTestId(DEDUCT_OPEN_BUTTON).click();
  await page.getByTestId(BARCODE_SCAN_BUTTON).click();
  await page.waitForFunction(() => window.__scanSuccess !== null);
  await page.evaluate((barcode) => window.__scanSuccess(barcode), '0000000000000');

  await expect(page.getByTestId(TOAST_NOTIFICATION)).toContainText('Barcode not found in database.');
  await expect(page.getByTestId(DEDUCT_ACTION_CONTAINER)).toBeHidden();
});
