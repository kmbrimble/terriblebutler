import { defineConfig } from '@playwright/test';
import { TEST_TOKEN } from './test-e2e/auth-fixtures.cjs';

const baseURL = 'http://127.0.0.1:2699';

export default defineConfig({
  testDir: './test-e2e',
  globalSetup: './test-e2e/global-setup.mjs',
  globalTeardown: './test-e2e/global-teardown.mjs',
  use: {
    headless: true,
    baseURL,
    // Pre-authenticate every test by default: the `request` fixture gets the token via
    // this header, and `page` navigations start with it already in localStorage. Tests
    // that need to exercise the logged-out state override storageState with test.use().
    extraHTTPHeaders: { Authorization: `Bearer ${TEST_TOKEN}` },
    storageState: {
      cookies: [],
      origins: [{ origin: baseURL, localStorage: [{ name: 'tb_token', value: TEST_TOKEN }] }],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
