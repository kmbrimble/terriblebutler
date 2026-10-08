import { test, expect } from './csp-guard.js';
import fs from 'node:fs';
import { ADD_OPEN_BUTTON, BARCODE_SCAN_BUTTON, BARCODE_SCANNER_READER, APP_ROOT } from './testids.js';

// The csp-guard auto fixture fails any test that triggers a CSP violation. These specs cover
// the paths the other specs stub out, and prove the CSP header is actually sent and enforced.

test('the real barcode scanner starts (camera stream, injected styles) without CSP violations', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(BARCODE_SCAN_BUTTON).click();
  await expect(page.getByTestId(BARCODE_SCANNER_READER).locator('video')).toBeAttached();
});

test('the app and every alternate-style page load only same-origin resources', async ({ page, baseURL }) => {
  const slugs = JSON.parse(fs.readFileSync('client/public/variants.json', 'utf8')).map((v) => v.slug);
  const foreign = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== new URL(baseURL).origin) foreign.push(req.url());
  });
  for (const path of ['/', ...slugs.map((s) => `/${s}.html`)]) {
    await page.goto(path);
    await expect(page.getByTestId(APP_ROOT)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  }
  expect(foreign).toEqual([]);
});

test('the server sends a CSP that blocks inline script, and the browser enforces it', async ({ page, request, cspViolations }) => {
  const res = await request.get('/');
  expect(res.headers()['content-security-policy']).toContain("script-src 'self'");

  await page.goto('/');
  // Deliberately provoke one violation to prove enforcement is live (a no-op policy would pass
  // every other test). The inline script must not run; the violation is expected, so the
  // guard's own list is cleared afterwards.
  const blocked = page.waitForEvent('console', (m) => m.text().startsWith('CSP-VIOLATION script-src'));
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true';
    document.head.appendChild(s);
    return window.__inlineRan === true;
  });
  await blocked;
  expect(ran).toBe(false);
  cspViolations.length = 0;
});
