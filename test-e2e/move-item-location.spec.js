import { test, expect } from '@playwright/test';
import {
  ITEM_CARD,
  QTY_DISPLAY_BUTTON,
  QTY_MODAL,
  QTY_MODAL_MOVE_LOCATION_SELECT,
  QTY_MODAL_MOVE_AMOUNT_INPUT,
  QTY_MODAL_MOVE_BUTTON,
} from './testids.js';

// fixes #39 — items had no way to move stock from a wrong location to the correct one, short of
// manually subtracting at the old location and re-adding at the new one.
test('a single-location item can have its stock moved to a different location via the Qty modal', async ({ page, request }) => {
  const locA = await (await request.post('/api/locations', { data: { name: `E2E Move Loc A ${Date.now()}` } })).json();
  const locB = await (await request.post('/api/locations', { data: { name: `E2E Move Loc B ${Date.now()}` } })).json();
  const name = `E2E Move Item ${Date.now()}`;
  await request.post('/api/items', { data: { name, location_id: locA.id, quantity: 4 } });

  await page.goto('/');
  const card = page.getByTestId(ITEM_CARD).filter({ hasText: name });
  await card.getByTestId(QTY_DISPLAY_BUTTON).click();

  const modal = page.getByTestId(QTY_MODAL);
  await modal.getByTestId(QTY_MODAL_MOVE_LOCATION_SELECT).selectOption(String(locB.id));
  await expect(modal.getByTestId(QTY_MODAL_MOVE_AMOUNT_INPUT)).toHaveValue('4');
  await modal.getByTestId(QTY_MODAL_MOVE_BUTTON).click();

  await expect(modal).toHaveCount(0);
  const itemRes = await request.get(`/api/items/search?q=${encodeURIComponent(name)}`);
  const [item] = await itemRes.json();
  const byLocation = Object.fromEntries(item.locations.map((l) => [l.location_id, l.quantity]));
  expect(byLocation[locA.id]).toBe(0);
  expect(byLocation[locB.id]).toBe(4);
});
