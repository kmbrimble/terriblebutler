import { test, expect } from './csp-guard.js';
import { signJwt, JWT_SECRET, AUTH_USERNAME } from './auth-fixtures.cjs';
import { LOGIN_SCREEN, APP_ROOT, EMPTY_STATE, ITEMS_ERROR, MENU_OPEN_BUTTON, MENU_LOGOUT_BUTTON,
  MENU_MANAGE_DEVICES_BUTTON, MANAGE_DEVICES_MODAL, MANAGE_DEVICES_SIGN_OUT_EVERYWHERE } from './testids.js';

const baseURL = 'http://127.0.0.1:2699';

test.describe('expired/invalid login', () => {
  // Negative TTL: genuinely expired (not just malformed), matching the diagnosed live bug —
  // a stale 30-day JWT past its exp claim, not a garbage token.
  const expiredToken = signJwt({ sub: AUTH_USERNAME }, JWT_SECRET, -60);

  test.use({
    storageState: {
      cookies: [],
      origins: [{ origin: baseURL, localStorage: [{ name: 'tb_token', value: expiredToken }] }],
    },
  });

  test('an expired token sends the user back to the login screen instead of an empty inventory', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId(LOGIN_SCREEN)).toBeVisible();
    await expect(page.getByTestId(APP_ROOT)).toBeHidden();
    await expect(page.getByTestId(EMPTY_STATE)).toHaveCount(0);

    const token = await page.evaluate(() => localStorage.getItem('tb_token'));
    expect(token).toBeNull();
  });
});

test('a non-401 failure fetching items shows an error, not "No items found."', async ({ page }) => {
  await page.route('**/api/items', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));

  await page.goto('/');

  await expect(page.getByTestId(APP_ROOT)).toBeVisible();
  await expect(page.getByTestId(ITEMS_ERROR)).toBeVisible();
  await expect(page.getByTestId(EMPTY_STATE)).toHaveCount(0);
});

test('logging out via the hamburger menu clears the token and returns to the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId(APP_ROOT)).toBeVisible();

  await page.getByTestId(MENU_OPEN_BUTTON).click();
  await page.getByTestId(MENU_LOGOUT_BUTTON).click();

  await expect(page.getByTestId(LOGIN_SCREEN)).toBeVisible();
  await expect(page.getByTestId(APP_ROOT)).toBeHidden();
  const token = await page.evaluate(() => localStorage.getItem('tb_token'));
  expect(token).toBeNull();
});

// The endpoint is stubbed: really revoking would bump the shared e2e server's token epoch and
// kill the fixture token every later spec uses. The server behaviour is covered in test/.
test('"Sign out everywhere" clears the token and returns to the login screen', async ({ page }) => {
  let revokeCalls = 0;
  await page.route('**/api/auth/revoke-all', (route) => {
    revokeCalls += 1;
    return route.fulfill({ status: 200, json: { success: true } });
  });
  await page.route('**/api/auth/devices', (route) => route.fulfill({ status: 200, json: [] }));
  page.once('dialog', (dialog) => dialog.accept());

  await page.goto('/');
  await expect(page.getByTestId(APP_ROOT)).toBeVisible();
  await page.getByTestId(MENU_OPEN_BUTTON).click();
  await page.getByTestId(MENU_MANAGE_DEVICES_BUTTON).click();
  await expect(page.getByTestId(MANAGE_DEVICES_MODAL)).toBeVisible();
  await page.getByTestId(MANAGE_DEVICES_SIGN_OUT_EVERYWHERE).click();

  await expect(page.getByTestId(LOGIN_SCREEN)).toBeVisible();
  expect(revokeCalls).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('tb_token'))).toBeNull();
});
