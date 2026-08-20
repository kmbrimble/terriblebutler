import { test, expect } from '@playwright/test';
import { AUTH_USERNAME, AUTH_PASSWORD } from './auth-fixtures.cjs';
import { LOGIN_SCREEN, APP_ROOT, LOGIN_USERNAME_INPUT, LOGIN_PASSWORD_INPUT, LOGIN_SUBMIT_BUTTON, LOGIN_ERROR } from './testids.js';

// The React client, now the default front end at /, proven here against the SAME testid
// contract as the legacy front end at /legacy (test-e2e/auth.spec.js) — reusing those
// constants unchanged is the proof the contract is genuinely front-end agnostic.

test.use({ storageState: { cookies: [], origins: [] } });

test('logged-out state renders the login screen', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId(LOGIN_SCREEN)).toBeVisible();
  await expect(page.getByTestId(APP_ROOT)).toBeHidden();
});

test('wrong credentials show an error and do not navigate', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId(LOGIN_USERNAME_INPUT).fill(AUTH_USERNAME);
  await page.getByTestId(LOGIN_PASSWORD_INPUT).fill('wrong-password');
  await page.getByTestId(LOGIN_SUBMIT_BUTTON).click();

  await expect(page.getByTestId(LOGIN_ERROR)).toBeVisible();
  await expect(page.getByTestId(LOGIN_SCREEN)).toBeVisible();
  await expect(page.getByTestId(APP_ROOT)).toBeHidden();
});

test('correct credentials transition to the authenticated view and the socket connects', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId(LOGIN_USERNAME_INPUT).fill(AUTH_USERNAME);
  await page.getByTestId(LOGIN_PASSWORD_INPUT).fill(AUTH_PASSWORD);
  await page.getByTestId(LOGIN_SUBMIT_BUTTON).click();

  await expect(page.getByTestId(LOGIN_SCREEN)).toBeHidden();
  await expect(page.getByTestId(APP_ROOT)).toBeVisible();
  // Observable connected state, not a sleep: Playwright polls this attribute until the
  // socket's 'connect' event flips it, or the assertion times out.
  await expect(page.getByTestId(APP_ROOT)).toHaveAttribute('data-socket-connected', 'true');
});
