import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  ADD_OPEN_BUTTON,
  SNAP_LABEL_FILE_INPUT,
  CROP_MODAL,
  CROP_CONFIRM_BUTTON,
  ITEM_NAME_INPUT,
  ITEM_CATEGORY_SELECT,
  CATEGORY_SUGGEST_BLOCK,
  CATEGORY_SUGGEST_SELECT,
  CATEGORY_SUGGEST_CUSTOM_INPUT,
  LOCATION_SUGGEST_BLOCK,
} from './testids.js';
import { waitForMutationBudget } from './rateLimitWait.js';

// Three of these four tests each make one real POST (a category, via "Use this") against the
// shared mutationRateLimiter budget — see v2-item-detail.spec.js's header comment for the full
// diagnosis. A cheap probe mutation before the heavier real work self-regulates against it.
test.beforeEach(async ({ request }) => {
  test.setTimeout(60_000);
  const probe = await request.post('/api/locations', { data: { name: `E2E V2 Label Probe ${Date.now()}` } });
  await waitForMutationBudget(probe);
});

const PRODUCT_IMAGE = path.join(process.cwd(), 'test/fixtures/product1.jpg');

// Unlike legacy's label-scan-suggestion.spec.js (which bypasses Cropper.js/camera entirely by
// calling applyLabelScanResult() directly on window), these drive the REAL file input and REAL
// Cropper.js crop UI on a fixture jpg — real Cropper.js works fine on a canvas in headless
// Chromium — and only mock the /api/parse-label-llm response, so the full wiring (file → crop
// → confirm → fetch → form update) is actually exercised end to end, not just the picker logic.

async function snapAndCrop(page) {
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(SNAP_LABEL_FILE_INPUT).setInputFiles(PRODUCT_IMAGE);
  await expect(page.getByTestId(CROP_MODAL)).toBeVisible();
  // Cropper.js initialises on a 50ms timer once the image has decoded; the confirm button
  // stays disabled until then (see CropModal.tsx), which is what this actually waits on.
  await expect(page.getByTestId(CROP_CONFIRM_BUTTON)).toBeEnabled();
  await page.getByTestId(CROP_CONFIRM_BUTTON).click();
}

test('v2: label scan applies an exact category/location match directly, no suggestion picker shown', async ({ page, request }) => {
  const created = await request.post('/api/categories', { data: { name: `E2E V2 Direct Category ${Date.now()}` } });
  const existing = await created.json();

  await page.route('**/api/parse-label-llm', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Some Product',
        container_details: '500g',
        category_id: existing.id,
        location_id: null,
        suggested_category_name: null,
        similar_category: null,
        suggested_location_name: null,
        similar_location: null,
      }),
    })
  );

  await page.goto('/');
  await snapAndCrop(page);

  await expect(page.getByTestId(ITEM_NAME_INPUT)).toHaveValue('Some Product');
  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(existing.id));
  await expect(page.getByTestId(CATEGORY_SUGGEST_BLOCK)).toBeHidden();
});

test('v2: label scan with no category match offers to add the scanned name as new, and applies it', async ({ page, request }) => {
  const categoryName = `E2E V2 Scanned Category ${Date.now()}`;

  await page.route('**/api/parse-label-llm', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Some Product',
        container_details: '',
        category_id: null,
        location_id: null,
        suggested_category_name: categoryName,
        similar_category: null,
        suggested_location_name: null,
        similar_location: null,
      }),
    })
  );

  await page.goto('/');
  await snapAndCrop(page);

  const panel = page.getByTestId(CATEGORY_SUGGEST_BLOCK);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(categoryName);
  await expect(page.getByTestId(CATEGORY_SUGGEST_SELECT)).toHaveValue('__new__');

  await panel.getByRole('button', { name: 'Use this' }).click();
  await expect(panel).toBeHidden();

  const catsRes = await request.get('/api/categories');
  const cats = await catsRes.json();
  const createdCat = cats.find((c) => c.name === categoryName);
  expect(createdCat).toBeTruthy();
  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(createdCat.id));
});

test('v2: label scan suggestion picker lets the user type a different custom category name', async ({ page, request }) => {
  const customName = `E2E V2 Custom Category ${Date.now()}`;

  await page.route('**/api/parse-label-llm', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Some Product',
        container_details: '',
        category_id: null,
        location_id: null,
        suggested_category_name: 'Some Suggested Category',
        similar_category: null,
        suggested_location_name: null,
        similar_location: null,
      }),
    })
  );

  await page.goto('/');
  await snapAndCrop(page);

  const panel = page.getByTestId(CATEGORY_SUGGEST_BLOCK);
  await expect(panel).toBeVisible();
  await page.getByTestId(CATEGORY_SUGGEST_SELECT).selectOption('__custom__');
  await expect(page.getByTestId(CATEGORY_SUGGEST_CUSTOM_INPUT)).toBeVisible();
  await page.getByTestId(CATEGORY_SUGGEST_CUSTOM_INPUT).fill(customName);
  await panel.getByRole('button', { name: 'Use this' }).click();
  await expect(panel).toBeHidden();

  const catsRes = await request.get('/api/categories');
  const cats = await catsRes.json();
  const createdCat = cats.find((c) => c.name === customName);
  expect(createdCat).toBeTruthy();
  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(createdCat.id));
});

test('v2: label scan surfaces category and location suggestions independently', async ({ page }) => {
  await page.route('**/api/parse-label-llm', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Some Product',
        container_details: '',
        category_id: null,
        location_id: null,
        suggested_category_name: 'Snacks',
        similar_category: null,
        suggested_location_name: 'Pantry',
        similar_location: null,
      }),
    })
  );

  await page.goto('/');
  await snapAndCrop(page);

  await expect(page.getByTestId(CATEGORY_SUGGEST_BLOCK)).toBeVisible();
  await expect(page.getByTestId(LOCATION_SUGGEST_BLOCK)).toBeVisible();
});
