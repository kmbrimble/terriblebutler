import { test, expect } from './csp-guard.js';
import { signJwt, JWT_SECRET, AUTH_USERNAME } from './auth-fixtures.cjs';
import { LOGIN_SCREEN, APP_ROOT, EMPTY_STATE, ITEMS_ERROR, MENU_OPEN_BUTTON, MENU_LOGOUT_BUTTON,
  MENU_MANAGE_DEVICES_BUTTON, MANAGE_DEVICES_MODAL, MANAGE_DEVICES_SIGN_OUT_EVERYWHERE, MANAGE_DEVICE_ROW,
  MANAGE_DEVICE_REVOKE_BUTTON, PASSWORD_CONFIRM_DIALOG, PASSWORD_CONFIRM_INPUT, PASSWORD_CONFIRM_ERROR,
  PASSWORD_CONFIRM_SUBMIT, PASSWORD_CONFIRM_CANCEL } from './testids.js';

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

// The endpoints are stubbed: really revoking would bump the shared e2e server's token epoch and
// kill the fixture token every later spec uses. The server behaviour is covered in test/.
async function openManageDevices(page) {
  await page.goto('/');
  await expect(page.getByTestId(APP_ROOT)).toBeVisible();
  await page.getByTestId(MENU_OPEN_BUTTON).click();
  await page.getByTestId(MENU_MANAGE_DEVICES_BUTTON).click();
  await expect(page.getByTestId(MANAGE_DEVICES_MODAL)).toBeVisible();
}

test('"Sign out everywhere" asks for the password, shows a wrong-password error, then signs out', async ({ page }) => {
  const sentPasswords = [];
  await page.route('**/api/auth/revoke-all', (route) => {
    const { password } = route.request().postDataJSON();
    sentPasswords.push(password);
    return password === 'right-password'
      ? route.fulfill({ status: 200, json: { success: true } })
      : route.fulfill({ status: 403, json: { error: 'Incorrect password.' } });
  });
  await page.route('**/api/auth/devices', (route) => route.fulfill({ status: 200, json: [] }));

  await openManageDevices(page);
  await page.getByTestId(MANAGE_DEVICES_SIGN_OUT_EVERYWHERE).click();
  await expect(page.getByTestId(PASSWORD_CONFIRM_DIALOG)).toBeVisible();

  await page.getByTestId(PASSWORD_CONFIRM_INPUT).fill('wrong-password');
  await page.getByTestId(PASSWORD_CONFIRM_SUBMIT).click();
  await expect(page.getByTestId(PASSWORD_CONFIRM_ERROR)).toHaveText('Incorrect password.');
  await expect(page.getByTestId(PASSWORD_CONFIRM_INPUT)).toHaveValue('');
  // A wrong password is not an expired session.
  await expect(page.getByTestId(PASSWORD_CONFIRM_DIALOG)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('tb_token'))).not.toBeNull();

  await page.getByTestId(PASSWORD_CONFIRM_INPUT).fill('right-password');
  await page.getByTestId(PASSWORD_CONFIRM_SUBMIT).click();

  await expect(page.getByTestId(LOGIN_SCREEN)).toBeVisible();
  expect(sentPasswords).toEqual(['wrong-password', 'right-password']);
  expect(await page.evaluate(() => localStorage.getItem('tb_token'))).toBeNull();
});

test('revoking one device asks for the password; cancelling sends nothing', async ({ page }) => {
  const revokeBodies = [];
  await page.route('**/api/auth/devices/7/revoke', (route) => {
    revokeBodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, json: { success: true } });
  });
  await page.route('**/api/auth/devices', (route) =>
    route.fulfill({ status: 200, json: [{ id: 7, device_label: 'Lost phone', created_at: '2026-01-01 00:00:00', last_used_at: '2026-01-02 00:00:00', revoked: 0 }] }));

  await openManageDevices(page);
  await expect(page.getByTestId(MANAGE_DEVICE_ROW)).toHaveCount(1);

  await page.getByTestId(MANAGE_DEVICE_REVOKE_BUTTON).click();
  await expect(page.getByTestId(PASSWORD_CONFIRM_DIALOG)).toBeVisible();
  await page.getByTestId(PASSWORD_CONFIRM_CANCEL).click();
  await expect(page.getByTestId(PASSWORD_CONFIRM_DIALOG)).toHaveCount(0);
  expect(revokeBodies).toEqual([]);

  await page.getByTestId(MANAGE_DEVICE_REVOKE_BUTTON).click();
  await page.getByTestId(PASSWORD_CONFIRM_INPUT).fill('right-password');
  await page.getByTestId(PASSWORD_CONFIRM_SUBMIT).click();
  await expect(page.getByTestId(PASSWORD_CONFIRM_DIALOG)).toHaveCount(0);
  expect(revokeBodies).toEqual([{ password: 'right-password' }]);
});
