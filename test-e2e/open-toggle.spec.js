import { test, expect } from '@playwright/test';
import { ITEM_CARD, OPEN_TOGGLE_BUTTON, QTY_DISPLAY_BUTTON, QTY_MODAL, QTY_MODAL_LOCATION_SELECT, QTY_MODAL_OPEN_TOGGLE } from './testids.js';

// fixes #35 — some items had no way to be flagged as opened.
test('a single-location item shows a card-level Open button that toggles is_open', async ({ page, request }) => {
  const loc = await (await request.post('/api/locations', { data: { name: `E2E Open Loc ${Date.now()}` } })).json();
  const name = `E2E Open Toggle Item ${Date.now()}`;
  await request.post('/api/items', { data: { name, location_id: loc.id, quantity: 2 } });

  await page.goto('/');
  const card = page.getByTestId(ITEM_CARD).filter({ hasText: name });
  const button = card.getByTestId(OPEN_TOGGLE_BUTTON);

  await expect(button).toHaveText('Open');
  await expect(button).not.toHaveClass(/border-orange-500/);
  await button.click();
  await expect(button).toHaveText('Open');
  await expect(button).toHaveClass(/border-orange-500/);

  await button.click();
  await expect(button).toHaveText('Open');
  await expect(button).not.toHaveClass(/border-orange-500/);
});

test('a multi-location item hides the card-level Open button but exposes one in the Qty modal per location', async ({ page, request }) => {
  const locA = await (await request.post('/api/locations', { data: { name: `E2E Open Multi A ${Date.now()}` } })).json();
  const locB = await (await request.post('/api/locations', { data: { name: `E2E Open Multi B ${Date.now()}` } })).json();
  const name = `E2E Open Toggle Multi Item ${Date.now()}`;
  const item = await (await request.post('/api/items', { data: { name, location_id: locA.id, quantity: 2 } })).json();
  await request.patch(`/api/items/${item.id}/quantity`, { data: { amount: 1, action: 'add', location_id: locB.id } });

  await page.goto('/');
  const card = page.getByTestId(ITEM_CARD).filter({ hasText: name });
  await expect(card.getByTestId(OPEN_TOGGLE_BUTTON)).toHaveCount(0);

  await card.getByTestId(QTY_DISPLAY_BUTTON).click();
  const modal = page.getByTestId(QTY_MODAL);
  const openToggle = modal.getByTestId(QTY_MODAL_OPEN_TOGGLE);
  await expect(openToggle).not.toBeChecked();

  await modal.getByTestId(QTY_MODAL_LOCATION_SELECT).selectOption(String(locA.id));
  await openToggle.check();
  await expect(openToggle).toBeChecked();

  const itemRes = await request.get(`/api/items/${item.id}/details`);
  const details = await itemRes.json();
  const locARow = details.locations.find((l) => l.location_id === locA.id);
  expect(locARow.is_open).toBe(1);
});
