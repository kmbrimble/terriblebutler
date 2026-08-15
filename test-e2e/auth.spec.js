import { test, expect } from '@playwright/test';
import { AUTH_USERNAME, AUTH_PASSWORD } from './auth-fixtures.cjs';

test.use({ storageState: { cookies: [], origins: [] } });

test('shows the login screen when logged out, and the app after logging in', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#appRoot')).toBeHidden();

  await page.fill('#loginUsername', AUTH_USERNAME);
  await page.fill('#loginPassword', AUTH_PASSWORD);
  await page.click('#loginForm button[type="submit"]');

  await expect(page.locator('#appRoot')).toBeVisible();
  await expect(page.locator('#loginScreen')).toBeHidden();
  await expect(page.locator('header')).toContainText('Terrible');
});

test('shows an error and stays logged out on bad credentials', async ({ page }) => {
  await page.goto('/');

  await page.fill('#loginUsername', AUTH_USERNAME);
  await page.fill('#loginPassword', 'wrong-password');
  await page.click('#loginForm button[type="submit"]');

  await expect(page.locator('#loginError')).toBeVisible();
  await expect(page.locator('#appRoot')).toBeHidden();
});
