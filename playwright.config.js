import { defineConfig } from '@playwright/test';
import { TEST_TOKEN } from './test-e2e/auth-fixtures.cjs';

const baseURL = 'http://127.0.0.1:2699';

export default defineConfig({
  testDir: './test-e2e',
  testIdAttribute: 'data-testid',
  globalSetup: './test-e2e/global-setup.mjs',
  globalTeardown: './test-e2e/global-teardown.mjs',
  // global-setup.mjs spins up ONE shared server + SQLite DB on a fixed port for the
  // whole run — every test in every worker hits the same live instance. Playwright's
  // default (CPU-core-based) worker count was measured to flake under that: repeated
  // runs at 8 workers occasionally crashed the shared server or returned bad responses
  // under concurrent load, with different unrelated tests failing each time. Pin to 1
  // until each worker gets its own isolated server+DB+port.
  workers: 1,
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
