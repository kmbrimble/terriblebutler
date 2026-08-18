import { test, expect } from '@playwright/test';
import { TITLE } from './testids.js';

test('browser launches and loads a data URL', async ({ page }) => {
  await page.setContent(`<h1 data-testid="${TITLE}">Hello Butler</h1>`);
  const text = await page.getByTestId(TITLE).textContent();
  expect(text).toBe('Hello Butler');
});
