import { test, expect } from '@playwright/test';
import { ADD_OPEN_BUTTON, ADD_MODAL, MODAL_CLOSE_BUTTON, MENU_OPEN_BUTTON, MENU_DRAWER, MANAGE_CATEGORIES_MODAL } from './testids.js';

// Issue #22: a fixed-position overlay doesn't stop the page underneath from scrolling, so a
// touch-scroll gesture on the overlay's own background could scroll the body behind it —
// reopening/closing a modal would then visibly jump to whatever scroll position that left
// behind. Not unit-testable (DOM/useEffect only; the client's vitest config has no DOM), so
// this asserts the actual browser mechanism: document.body's computed overflow is locked to
// 'hidden' for exactly as long as a modal is mounted, across two independently-implemented
// modals (ItemFormModal and ManageCategoriesModal) to confirm the shared hook, not one-off
// component logic, is what's doing the locking.
async function bodyOverflow(page) {
  return page.evaluate(() => getComputedStyle(document.body).overflow);
}

test('opening a modal locks background scroll, closing it restores the previous value', async ({ page }) => {
  await page.goto('/');
  expect(await bodyOverflow(page)).not.toBe('hidden');

  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeVisible();
  expect(await bodyOverflow(page)).toBe('hidden');

  await page.getByTestId(MODAL_CLOSE_BUTTON).click();
  await expect(page.getByTestId(ADD_MODAL)).toBeHidden();
  expect(await bodyOverflow(page)).not.toBe('hidden');

  await page.getByTestId(MENU_OPEN_BUTTON).click();
  await expect(page.getByTestId(MENU_DRAWER)).toBeVisible();
  await page.getByRole('button', { name: 'Manage Categories' }).click();
  await expect(page.getByTestId(MANAGE_CATEGORIES_MODAL)).toBeVisible();
  expect(await bodyOverflow(page)).toBe('hidden');

  await page.getByTestId(MANAGE_CATEGORIES_MODAL).getByRole('button', { name: '×' }).click();
  await expect(page.getByTestId(MANAGE_CATEGORIES_MODAL)).toBeHidden();
  expect(await bodyOverflow(page)).not.toBe('hidden');
});
