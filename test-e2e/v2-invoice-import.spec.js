import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  INVOICE_IMPORT_OPEN_BUTTON,
  INVOICE_IMPORT_FILE_INPUT,
  INVOICE_IMPORT_STAGING_CONTAINER,
  INVOICE_IMPORT_SUMMARY_LINE,
  INVOICE_IMPORT_COMMIT_BUTTON,
  INVOICE_IMPORT_LINE,
  INVOICE_IMPORT_LINE_CATEGORY_SELECT,
  INVOICE_IMPORT_LINE_NAME_INPUT,
  INVOICE_IMPORT_LINE_CONTAINER_INPUT,
  INVOICE_IMPORT_LINE_MATCH_INPUT,
  INVOICE_IMPORT_MODAL,
  TOAST_NOTIFICATION,
} from './testids.js';
import { waitForMutationBudget, requestWithRateLimitRetry } from './rateLimitWait.js';

// Mirrors test-e2e/invoice-import.spec.js, reusing the same real PDF fixtures — this is the
// deterministic Coles/Woolworths parser flow (server-side staging in invoice_imports/
// invoice_import_lines), not the plain LLM upload+commit flow (see this stage's CHANGELOG for
// why that one's out of scope). localStorage's tb_active_import_id is the same key legacy
// uses, so an import started on either front end resumes on either.

const WOOLWORTHS_PDF = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
const COLES_PDF = path.join(process.cwd(), 'test/fixtures/invoices/coles-example.pdf');

function lineRow(page, lineId) {
  return page.getByTestId(INVOICE_IMPORT_LINE).and(page.locator(`[data-line-id="${lineId}"]`));
}

test('v2: uploading a Woolworths PDF renders the review checklist with the correct line count', async ({ page, request }) => {
  test.setTimeout(60_000);
  const probe = await request.post('/api/locations', { data: { name: `E2E V2 Invoice Probe ${Date.now()}` } });
  await waitForMutationBudget(probe);

  await page.goto('/');
  await page.getByTestId(INVOICE_IMPORT_OPEN_BUTTON).click();
  await page.getByTestId(INVOICE_IMPORT_FILE_INPUT).setInputFiles(WOOLWORTHS_PDF);

  await expect(page.getByTestId(INVOICE_IMPORT_STAGING_CONTAINER)).toBeVisible();
  await expect(page.getByTestId(INVOICE_IMPORT_LINE)).toHaveCount(32);
  await expect(page.getByTestId(INVOICE_IMPORT_SUMMARY_LINE)).toContainText('32 lines');
  await expect(page.getByTestId(INVOICE_IMPORT_COMMIT_BUTTON)).toBeDisabled();
});

test('v2: a category change on one line persists across a page reload (crash-safety)', async ({ page, request }) => {
  test.setTimeout(90_000);
  const probe = await request.post('/api/locations', { data: { name: `E2E V2 Invoice Probe ${Date.now()}` } });
  await waitForMutationBudget(probe);

  await page.goto('/');
  await page.getByTestId(INVOICE_IMPORT_OPEN_BUTTON).click();

  const [importRes] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/invoices/import') && res.request().method() === 'POST'),
    page.getByTestId(INVOICE_IMPORT_FILE_INPUT).setInputFiles(WOOLWORTHS_PDF),
  ]);
  const importBody = await importRes.json();
  const importId = importBody.import.id;
  const firstLineId = importBody.lines[0].id;

  const catRes = await requestWithRateLimitRetry(() => request.post('/api/categories', { data: { name: `E2E V2 Invoice Category ${Date.now()}` } }));
  const category = await catRes.json();

  await expect(page.getByTestId(INVOICE_IMPORT_STAGING_CONTAINER)).toBeVisible();
  await lineRow(page, firstLineId).getByTestId(INVOICE_IMPORT_LINE_CATEGORY_SELECT).selectOption(String(category.id));

  // The in-progress import auto-resumes on load (tb_active_import_id in localStorage) — no
  // need to click the open button again, and the modal now covers it anyway.
  await page.reload();
  await expect(page.getByTestId(INVOICE_IMPORT_STAGING_CONTAINER)).toBeVisible();
  await expect(lineRow(page, firstLineId).getByTestId(INVOICE_IMPORT_LINE_CATEGORY_SELECT)).toHaveValue(String(category.id));

  const getRes = await request.get(`/api/invoices/import/${importId}`);
  const persisted = await getRes.json();
  expect(persisted.lines.find((l) => l.id === firstLineId).final_category_id).toBe(category.id);
});

test('v2: editing name/container and picking an existing item to merge into persist across a reload (fixes #40)', async ({ page, request }) => {
  test.setTimeout(90_000);
  const existingName = `E2E V2 Merge Target ${Date.now()}`;
  const existing = await requestWithRateLimitRetry(() => request.post('/api/items', { data: { name: existingName, quantity: 1 } }));
  const existingItem = await existing.json();

  await page.goto('/');
  await page.getByTestId(INVOICE_IMPORT_OPEN_BUTTON).click();

  const [importRes] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/invoices/import') && res.request().method() === 'POST'),
    page.getByTestId(INVOICE_IMPORT_FILE_INPUT).setInputFiles(WOOLWORTHS_PDF),
  ]);
  const importBody = await importRes.json();
  const importId = importBody.import.id;
  const firstLineId = importBody.lines[0].id;

  await expect(page.getByTestId(INVOICE_IMPORT_STAGING_CONTAINER)).toBeVisible();
  const row = lineRow(page, firstLineId);
  await row.getByTestId(INVOICE_IMPORT_LINE_NAME_INPUT).fill('Edited Product Name');
  await row.getByTestId(INVOICE_IMPORT_LINE_CONTAINER_INPUT).fill('500g tub');
  const matchInput = row.getByTestId(INVOICE_IMPORT_LINE_MATCH_INPUT);
  await matchInput.fill(existingName);
  await matchInput.blur();

  await expect(async () => {
    const getRes = await request.get(`/api/invoices/import/${importId}`);
    const persisted = (await getRes.json()).lines.find((l) => l.id === firstLineId);
    expect(persisted.final_name).toBe('Edited Product Name');
    expect(persisted.final_container_details).toBe('500g tub');
    expect(persisted.matched_item_id).toBe(existingItem.id);
  }).toPass();

  await page.reload();
  await expect(page.getByTestId(INVOICE_IMPORT_STAGING_CONTAINER)).toBeVisible();
  const reloadedRow = lineRow(page, firstLineId);
  await expect(reloadedRow.getByTestId(INVOICE_IMPORT_LINE_NAME_INPUT)).toHaveValue('Edited Product Name');
  await expect(reloadedRow.getByTestId(INVOICE_IMPORT_LINE_CONTAINER_INPUT)).toHaveValue('500g tub');
  await expect(reloadedRow.getByTestId(INVOICE_IMPORT_LINE_MATCH_INPUT)).toHaveValue(existingName);
});

test('v2: completing a review and committing shows a summary and creates the expected items', async ({ page, request }) => {
  test.setTimeout(120_000);
  // Extra generous: import + one PATCH per Coles line (line count varies with the fixture PDF,
  // typically 20-30) + commit, all against the same shared 90/60s budget.
  const probe = await request.post('/api/locations', { data: { name: `E2E V2 Invoice Probe ${Date.now()}` } });
  await waitForMutationBudget(probe, 50);

  await page.goto('/');
  await page.getByTestId(INVOICE_IMPORT_OPEN_BUTTON).click();

  const [importRes] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/invoices/import') && res.request().method() === 'POST'),
    page.getByTestId(INVOICE_IMPORT_FILE_INPUT).setInputFiles(COLES_PDF),
  ]);
  const importBody = await importRes.json();
  const importId = importBody.import.id;

  // Bulk-mark every line reviewed via the API — setup, not the behaviour under test. The
  // commit itself goes through the real "Import to Inventory" button. Each PATCH is retried
  // individually against the shared budget since a loop this size can outlast one pre-emptive
  // wait's accuracy.
  for (const line of importBody.lines) {
    await requestWithRateLimitRetry(() => request.patch(`/api/invoices/import/${importId}/lines/${line.id}`, { data: { line_status: 'reviewed' } }));
  }

  // Auto-resumes on load — see the crash-safety test's comment above.
  await page.reload();
  await expect(page.getByTestId(INVOICE_IMPORT_STAGING_CONTAINER)).toBeVisible();
  const commitBtn = page.getByTestId(INVOICE_IMPORT_COMMIT_BUTTON);
  await expect(commitBtn).toBeEnabled();
  await commitBtn.click();

  await expect(page.getByTestId(TOAST_NOTIFICATION)).toContainText('Imported:');

  const itemsRes = await request.get('/api/items');
  const items = await itemsRes.json();
  expect(items.find((i) => i.name === 'ABC Sweet Soy Sauce 620mL')).toBeTruthy();
  expect(items.find((i) => i.name === "Coles I'm Perfect Sweet Potato 1.5kg")).toBeTruthy();

  // Resuming after a commit shouldn't re-open the same import — it's done. The invoice-import
  // modal itself is closed after a commit (onCommitted), so re-opening it should show the
  // empty file-picker state, not a stale staging container.
  await page.reload();
  await page.getByTestId(INVOICE_IMPORT_OPEN_BUTTON).click();
  await expect(page.getByTestId(INVOICE_IMPORT_MODAL)).toBeVisible();
  await expect(page.getByTestId(INVOICE_IMPORT_STAGING_CONTAINER)).toBeHidden();
});
