import { test, expect } from '@playwright/test';
import {
  MENU_OPEN_BUTTON,
  MENU_DRAWER,
  MENU_DARK_MODE_TOGGLE,
  INVOICE_IMPORT_MODAL,
  MANAGE_CATEGORIES_MODAL,
  MANAGE_CATEGORIES_NEW_INPUT,
  MANAGE_CATEGORY_ROW,
  MANAGE_CATEGORY_EDIT_BUTTON,
  MANAGE_CATEGORY_DELETE_BUTTON,
  MANAGE_LOCATIONS_MODAL,
  MANAGE_LOCATIONS_NEW_INPUT,
  MANAGE_LOCATION_ROW,
  MANAGE_LOCATION_EDIT_BUTTON,
  MANAGE_LOCATION_DELETE_BUTTON,
} from './testids.js';

// Fixes a post-cutover functional regression: legacy's hamburger/settings drawer
// (public/index.html L138-198) was never ported to the React client (now the default front
// end at `/` — see 0.27). This is the first e2e coverage for any of it; legacy itself has none
// (confirmed via repository-reader — no existing spec references the drawer). Sort By/Sort
// Direction/Expanded View are deliberately NOT duplicated into the drawer (already inline and
// covered by v2-inventory.spec.js); "Upload Invoice" (the plain-LLM flow) is deliberately not
// ported at all (see CHANGELOG) so isn't tested here either.

const prefix = `E2E Menu ${Date.now()}`;

function categoryRow(page, id) {
  return page.getByTestId(MANAGE_CATEGORY_ROW).and(page.locator(`[data-category-id="${id}"]`));
}
function locationRow(page, id) {
  return page.getByTestId(MANAGE_LOCATION_ROW).and(page.locator(`[data-location-id="${id}"]`));
}

test('menu button opens the drawer, and each item that isn\'t reachable elsewhere works', async ({ page, request }) => {
  const cat = await request.post('/api/categories', { data: { name: `${prefix} Cat` } });
  expect(cat.ok()).toBeTruthy();
  const catData = await cat.json();
  const loc = await request.post('/api/locations', { data: { name: `${prefix} Loc` } });
  expect(loc.ok()).toBeTruthy();
  const locData = await loc.json();

  page.on('dialog', (dialog) => dialog.accept(dialog.type() === 'prompt' ? `${prefix} Renamed` : undefined));

  await page.goto('/');

  // Menu button exists and opens the drawer.
  await expect(page.getByTestId(MENU_DRAWER)).toBeHidden();
  await page.getByTestId(MENU_OPEN_BUTTON).click();
  await expect(page.getByTestId(MENU_DRAWER)).toBeVisible();

  // Import Coles/Woolworths opens the existing invoice-import modal (shared with the header
  // button) and closes the drawer, matching legacy's toggleDrawer(); openInvoiceImportModal().
  await page.getByRole('button', { name: 'Import Coles/Woolworths Invoice' }).click();
  await expect(page.getByTestId(INVOICE_IMPORT_MODAL)).toBeVisible();
  await expect(page.getByTestId(MENU_DRAWER)).toBeHidden();
  await page.getByTestId(INVOICE_IMPORT_MODAL).getByRole('button', { name: '×' }).click();

  // Toggle Full Screen: previously entirely unreachable in the React client. Headless Chromium
  // rejects requestFullscreen(), which legacy's own handler already tolerates (a .catch()) — the
  // functional assertion here is that clicking it doesn't crash the app.
  await page.getByTestId(MENU_OPEN_BUTTON).click();
  await page.getByRole('button', { name: 'Toggle Full Screen' }).click();
  await expect(page.getByTestId(MENU_DRAWER)).toBeHidden();
  await expect(page.getByTestId(MENU_OPEN_BUTTON)).toBeVisible();

  // Dark Mode: previously no UI control existed at all (the localStorage key worked, nothing
  // could set it). Toggling flips the documentElement class and persists the same key legacy
  // and client/index.html's pre-paint script both read.
  await page.getByTestId(MENU_OPEN_BUTTON).click();
  const themeToggle = page.getByTestId(MENU_DARK_MODE_TOGGLE);
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  // The checkbox is visually hidden (sr-only) behind a styled toggle track, same pattern as
  // legacy's #themeToggle — force the click past the intercepting sibling div, same as a real
  // tap on the visible track would land on the label's underlying input.
  await themeToggle.click({ force: true });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(!wasDark);
  const storedTheme = await page.evaluate(() => localStorage.getItem('tb_theme'));
  expect(storedTheme).toBe(wasDark ? 'light' : 'dark');
  await themeToggle.click({ force: true }); // restore, so it doesn't leak into other tests via shared server state assumptions

  // Manage Categories: previously entirely unreachable (create-only elsewhere in the app).
  // Add + edit (prompt) + delete (confirm), matching legacy's editCategory()/deleteCategory().
  await page.getByRole('button', { name: 'Manage Categories' }).click();
  await expect(page.getByTestId(MANAGE_CATEGORIES_MODAL)).toBeVisible();
  await expect(categoryRow(page, catData.id)).toContainText(`${prefix} Cat`);

  await page.getByTestId(MANAGE_CATEGORIES_NEW_INPUT).fill(`${prefix} Cat New`);
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId(MANAGE_CATEGORY_ROW).filter({ hasText: `${prefix} Cat New` })).toBeVisible();

  await categoryRow(page, catData.id).getByTestId(MANAGE_CATEGORY_EDIT_BUTTON).click();
  await expect(categoryRow(page, catData.id)).toContainText(`${prefix} Renamed`);

  await categoryRow(page, catData.id).getByTestId(MANAGE_CATEGORY_DELETE_BUTTON).click();
  await expect(categoryRow(page, catData.id)).toHaveCount(0);
  await page.getByTestId(MANAGE_CATEGORIES_MODAL).getByRole('button', { name: '×' }).click();

  // Manage Locations: same shape as categories.
  await page.getByTestId(MENU_OPEN_BUTTON).click();
  await page.getByRole('button', { name: 'Manage Locations' }).click();
  await expect(page.getByTestId(MANAGE_LOCATIONS_MODAL)).toBeVisible();
  await expect(locationRow(page, locData.id)).toContainText(`${prefix} Loc`);

  await page.getByTestId(MANAGE_LOCATIONS_NEW_INPUT).fill(`${prefix} Loc New`);
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId(MANAGE_LOCATION_ROW).filter({ hasText: `${prefix} Loc New` })).toBeVisible();

  await locationRow(page, locData.id).getByTestId(MANAGE_LOCATION_EDIT_BUTTON).click();
  await expect(locationRow(page, locData.id)).toContainText(`${prefix} Renamed`);

  await locationRow(page, locData.id).getByTestId(MANAGE_LOCATION_DELETE_BUTTON).click();
  await expect(locationRow(page, locData.id)).toHaveCount(0);
});
