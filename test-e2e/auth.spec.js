import { test, expect } from '@playwright/test';
import { AUTH_USERNAME, AUTH_PASSWORD } from './auth-fixtures.cjs';
import { LOGIN_SCREEN, APP_ROOT, LOGIN_USERNAME_INPUT, LOGIN_PASSWORD_INPUT, LOGIN_SUBMIT_BUTTON, LOGIN_ERROR } from './testids.js';

test.use({ storageState: { cookies: [], origins: [] } });

test('shows the login screen when logged out, and the app after logging in', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId(LOGIN_SCREEN)).toBeVisible();
  await expect(page.getByTestId(APP_ROOT)).toBeHidden();

  await page.getByTestId(LOGIN_USERNAME_INPUT).fill(AUTH_USERNAME);
  await page.getByTestId(LOGIN_PASSWORD_INPUT).fill(AUTH_PASSWORD);
  await page.getByTestId(LOGIN_SUBMIT_BUTTON).click();

  await expect(page.getByTestId(APP_ROOT)).toBeVisible();
  await expect(page.getByTestId(LOGIN_SCREEN)).toBeHidden();
  await expect(page.locator('header')).toContainText('Terrible');
});

test('shows an error and stays logged out on bad credentials', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId(LOGIN_USERNAME_INPUT).fill(AUTH_USERNAME);
  await page.getByTestId(LOGIN_PASSWORD_INPUT).fill('wrong-password');
  await page.getByTestId(LOGIN_SUBMIT_BUTTON).click();

  await expect(page.getByTestId(LOGIN_ERROR)).toBeVisible();
  await expect(page.getByTestId(APP_ROOT)).toBeHidden();
});
