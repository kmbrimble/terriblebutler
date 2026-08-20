import { test, expect } from '@playwright/test';

test('the app loads and shows the header', async ({ page }) => {
  await page.goto('/legacy/');
  await expect(page.locator('header')).toContainText('Terrible');
});
