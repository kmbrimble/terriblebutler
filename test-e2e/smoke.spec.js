import { test, expect } from '@playwright/test';

test('browser launches and loads a data URL', async ({ page }) => {
  await page.setContent('<h1 id="title">Hello Butler</h1>');
  const text = await page.textContent('#title');
  expect(text).toBe('Hello Butler');
});
