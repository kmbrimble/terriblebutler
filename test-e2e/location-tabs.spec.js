import { test, expect } from '@playwright/test';
import { LOCATION_TAB_BUTTON, ITEM_CARD } from './testids.js';

test('the three special tabs are always present', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByTestId(LOCATION_TAB_BUTTON);
  await expect(tabs.filter({ hasText: 'All Inventory' })).toHaveCount(1);
  await expect(tabs.filter({ hasText: 'Grocery List' })).toHaveCount(1);
  await expect(tabs.filter({ hasText: 'Ignored Out-of-Stock' })).toHaveCount(1);
});

test('a newly seeded location gets its own tab and filters items to that location', async ({ page, request }) => {
  const locationName = `E2E Location ${Date.now()}`;
  const locRes = await request.post('/api/locations', { data: { name: locationName } });
  expect(locRes.ok()).toBeTruthy();
  const location = await locRes.json();

  const otherLocations = (await (await request.get('/api/locations')).json()).filter(l => l.id !== location.id);
  const otherLocation = otherLocations[0];

  const inLocationItemName = `E2E In-Location Item ${Date.now()}`;
  const outsideItemName = `E2E Outside Item ${Date.now()}`;

  const inItemRes = await request.post('/api/items', {
    data: { name: inLocationItemName, location_id: location.id, quantity: 5, reorder_threshold: 1 },
  });
  expect(inItemRes.ok()).toBeTruthy();

  const outsideItemRes = await request.post('/api/items', {
    data: { name: outsideItemName, location_id: otherLocation.id, quantity: 5, reorder_threshold: 1 },
  });
  expect(outsideItemRes.ok()).toBeTruthy();

  await page.goto('/');

  const tabButton = page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: locationName });
  await expect(tabButton).toHaveCount(1);

  // special tabs remain present alongside the new location tab
  await expect(page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'All Inventory' })).toHaveCount(1);
  await expect(page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Grocery List' })).toHaveCount(1);
  await expect(page.getByTestId(LOCATION_TAB_BUTTON).filter({ hasText: 'Ignored Out-of-Stock' })).toHaveCount(1);

  await tabButton.click();

  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: inLocationItemName })).toBeVisible();
  await expect(page.getByTestId(ITEM_CARD).filter({ hasText: outsideItemName })).toHaveCount(0);
});

test('renaming a location updates its tab label and deleting it falls back to All Inventory', async ({ page, request }) => {
  const originalName = `E2E Rename ${Date.now()}`;
  const locRes = await request.post('/api/locations', { data: { name: originalName } });
  const location = await locRes.json();

  await page.goto('/');

  const originalTab = page.getByRole('button', { name: originalName, exact: true });
  await expect(originalTab).toHaveCount(1);
  await originalTab.click();
  await expect(originalTab).toHaveClass(/bg-rimmy-purple/);

  const renamedName = `${originalName} Renamed`;
  const renameRes = await request.put(`/api/locations/${location.id}`, { data: { name: renamedName } });
  expect(renameRes.ok()).toBeTruthy();

  const renamedTab = page.getByRole('button', { name: renamedName, exact: true });
  await expect(renamedTab).toHaveCount(1);
  await expect(page.getByRole('button', { name: originalName, exact: true })).toHaveCount(0);
  await expect(renamedTab).toHaveClass(/bg-rimmy-purple/);

  const deleteRes = await request.delete(`/api/locations/${location.id}`);
  expect(deleteRes.ok()).toBeTruthy();

  await expect(page.getByRole('button', { name: renamedName, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'All Inventory', exact: true })).toHaveClass(/bg-rimmy-purple/);
});
