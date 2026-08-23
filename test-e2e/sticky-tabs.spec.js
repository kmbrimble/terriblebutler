import { test, expect } from '@playwright/test';
import { TAB_BAR } from './testids.js';

// fixes #36 — the location tab bar scrolled out of view under a long item list; it should
// stay pinned under the header like the header pins itself.
test('the tab bar stays pinned near the top of the viewport after scrolling a long item list', async ({ page, request }) => {
  const prefix = `E2E Sticky ${Date.now()}`;
  for (let i = 0; i < 30; i++) {
    await request.post('/api/items', { data: { name: `${prefix} Item ${i}`, quantity: 1 } });
  }

  await page.goto('/');
  const tabBar = page.getByTestId(TAB_BAR);
  await expect(tabBar).toBeVisible();

  await page.mouse.wheel(0, 2000);
  await expect(tabBar).toBeVisible();
  const box = await tabBar.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeLessThan(150);
});
