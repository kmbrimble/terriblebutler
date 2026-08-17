import { test, expect } from '@playwright/test';
import path from 'node:path';

// openInvoiceImportModal() etc. are top-level `function` declarations in the page's inline
// script, so — unlike the `let` state vars — they land on `window` and are safe to call
// directly, same seam-stubbing approach as label-scan-suggestion.spec.js.

const WOOLWORTHS_PDF = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
const COLES_PDF = path.join(process.cwd(), 'test/fixtures/invoices/coles-example.pdf');

test('invoice import: uploading a Woolworths PDF renders the review checklist with the correct line count', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.openInvoiceImportModal());
  await page.locator('#invoiceImportFileInput').setInputFiles(WOOLWORTHS_PDF);

  await expect(page.locator('#invoiceImportStagingContainer')).toBeVisible();
  await expect(page.locator('#invoiceImportStagingList > div')).toHaveCount(32);
  await expect(page.locator('#invoiceImportSummaryLine')).toContainText('32 lines');
  await expect(page.locator('#invoiceImportCommitBtn')).toBeDisabled();
});

test('invoice import: a category change on one line persists across a page reload (crash-safety)', async ({ page, request }) => {
  await page.goto('/');
  await page.evaluate(() => window.openInvoiceImportModal());

  const [importRes] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/invoices/import') && res.request().method() === 'POST'),
    page.locator('#invoiceImportFileInput').setInputFiles(WOOLWORTHS_PDF),
  ]);
  const importBody = await importRes.json();
  const importId = importBody.import.id;
  const firstLineId = importBody.lines[0].id;

  const catRes = await request.post('/api/categories', { data: { name: `E2E Invoice Category ${Date.now()}` } });
  const category = await catRes.json();

  await expect(page.locator('#invoiceImportStagingContainer')).toBeVisible();
  await page.locator(`#il_cat_${firstLineId}`).selectOption(String(category.id));
  // No save button anywhere on this screen — the select's own onchange already PATCHed it.

  await page.reload();
  await expect(page.locator('#invoiceImportStagingContainer')).toBeVisible();
  await expect(page.locator(`#il_cat_${firstLineId}`)).toHaveValue(String(category.id));

  const getRes = await request.get(`/api/invoices/import/${importId}`);
  const persisted = await getRes.json();
  expect(persisted.lines.find((l) => l.id === firstLineId).final_category_id).toBe(category.id);
});

test('invoice import: completing a review and committing shows a summary and creates the expected items', async ({ page, request }) => {
  await page.goto('/');
  await page.evaluate(() => window.openInvoiceImportModal());

  const [importRes] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/invoices/import') && res.request().method() === 'POST'),
    page.locator('#invoiceImportFileInput').setInputFiles(COLES_PDF),
  ]);
  const importBody = await importRes.json();
  const importId = importBody.import.id;

  // Bulk-mark every line reviewed via the API — setup, not the behaviour under test. The
  // commit itself below goes through the real "Import to Inventory" button, which is what
  // exercises the enabled/disabled gate this test actually cares about.
  for (const line of importBody.lines) {
    await request.patch(`/api/invoices/import/${importId}/lines/${line.id}`, { data: { line_status: 'reviewed' } });
  }

  await page.reload();
  await expect(page.locator('#invoiceImportStagingContainer')).toBeVisible();
  const commitBtn = page.locator('#invoiceImportCommitBtn');
  await expect(commitBtn).toBeEnabled();
  await commitBtn.click();

  await expect(page.locator('#toastNotification')).toContainText('Imported:');

  const itemsRes = await request.get('/api/items');
  const items = await itemsRes.json();
  expect(items.find((i) => i.name === 'ABC Sweet Soy Sauce 620mL')).toBeTruthy();
  expect(items.find((i) => i.name === "Coles I'm Perfect Sweet Potato 1.5kg")).toBeTruthy();

  // Resuming after a commit shouldn't re-open the same import — it's done.
  await page.reload();
  await expect(page.locator('#invoiceImportModal')).toBeHidden();
});
