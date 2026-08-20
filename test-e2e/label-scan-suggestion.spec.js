import { test, expect } from '@playwright/test';
import { ADD_OPEN_BUTTON, CATEGORY_SUGGEST_BLOCK, CATEGORY_SUGGEST_SELECT, CATEGORY_SUGGEST_CUSTOM_INPUT, ITEM_CATEGORY_SELECT } from './testids.js';

// applyLabelScanResult() is the frontend function that turns a /api/parse-label-llm
// response into form updates + the category/location suggestion picker. It's called
// directly here (bypassing the real Cropper.js/camera flow, same seam-stubbing approach
// as barcode-scan.spec.js) so these tests exercise the actual picker logic and the real
// /api/categories + /api/locations endpoints behind "Use this".

test('label scan: no match offers to add the scanned category as new, and applies it', async ({ page, request }) => {
  const categoryName = `E2E Scanned Category ${Date.now()}`;

  await page.goto('/legacy/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();

  await page.evaluate((name) => window.applyLabelScanResult({
    name: 'Some Product',
    category_id: null,
    location_id: null,
    suggested_category_name: name,
    similar_category: null,
  }), categoryName);

  const panel = page.getByTestId(CATEGORY_SUGGEST_BLOCK);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(categoryName);
  await expect(page.getByTestId(CATEGORY_SUGGEST_SELECT)).toHaveValue('__new__');

  await panel.getByRole('button', { name: 'Use this' }).click();
  await expect(panel).toBeHidden();

  const catsRes = await request.get('/api/categories');
  const cats = await catsRes.json();
  const created = cats.find((c) => c.name === categoryName);
  expect(created).toBeTruthy();

  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(created.id));
});

test('label scan: a close existing category is pre-selected and does not create a duplicate', async ({ page, request }) => {
  const existingName = `E2E Existing Category ${Date.now()}`;
  const created = await request.post('/api/categories', { data: { name: existingName } });
  const existing = await created.json();

  await page.goto('/legacy/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  // The category list is fetched asynchronously on page load; wait for it to actually
  // land before the suggestion picker (built from that same in-memory list) is rendered.
  await expect(page.getByTestId(ITEM_CATEGORY_SELECT).locator(`option[value="${existing.id}"]`)).toBeAttached();

  await page.evaluate(({ name, id }) => window.applyLabelScanResult({
    name: 'Some Product',
    category_id: null,
    location_id: null,
    suggested_category_name: `${name} Typo`,
    similar_category: { id, name },
  }), { name: existingName, id: existing.id });

  const panel = page.getByTestId(CATEGORY_SUGGEST_BLOCK);
  await expect(panel).toBeVisible();
  await expect(page.getByTestId(CATEGORY_SUGGEST_SELECT)).toHaveValue(String(existing.id));

  await panel.getByRole('button', { name: 'Use this' }).click();
  await expect(panel).toBeHidden();

  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(existing.id));

  const catsRes = await request.get('/api/categories');
  const cats = await catsRes.json();
  expect(cats.filter((c) => c.name.startsWith(`${existingName}`))).toHaveLength(1);
});

test('label scan: user can override the suggestion and type a different new category name', async ({ page, request }) => {
  const customName = `E2E Custom Category ${Date.now()}`;

  await page.goto('/legacy/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();

  await page.evaluate(() => window.applyLabelScanResult({
    name: 'Some Product',
    category_id: null,
    location_id: null,
    suggested_category_name: 'Some Suggested Category',
    similar_category: null,
  }));

  const panel = page.getByTestId(CATEGORY_SUGGEST_BLOCK);
  await expect(panel).toBeVisible();

  await page.getByTestId(CATEGORY_SUGGEST_SELECT).selectOption('__custom__');
  await expect(page.getByTestId(CATEGORY_SUGGEST_CUSTOM_INPUT)).toBeVisible();
  await page.getByTestId(CATEGORY_SUGGEST_CUSTOM_INPUT).fill(customName);

  await panel.getByRole('button', { name: 'Use this' }).click();
  await expect(panel).toBeHidden();

  const catsRes = await request.get('/api/categories');
  const cats = await catsRes.json();
  const created = cats.find((c) => c.name === customName);
  expect(created).toBeTruthy();
  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(created.id));
});

test('label scan: an exact category/location match populates the form directly, no picker shown', async ({ page, request }) => {
  const created = await request.post('/api/categories', { data: { name: `E2E Direct Category ${Date.now()}` } });
  const existing = await created.json();

  await page.goto('/legacy/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  // The category list is fetched asynchronously on page load; wait for it to actually
  // land in the <select> before relying on its option being present.
  await expect(page.getByTestId(ITEM_CATEGORY_SELECT).locator(`option[value="${existing.id}"]`)).toBeAttached();

  await page.evaluate((id) => window.applyLabelScanResult({
    name: 'Some Product',
    category_id: id,
    location_id: null,
    suggested_category_name: null,
    similar_category: null,
  }), existing.id);

  await expect(page.getByTestId(ITEM_CATEGORY_SELECT)).toHaveValue(String(existing.id));
  await expect(page.getByTestId(CATEGORY_SUGGEST_BLOCK)).toBeHidden();
});
