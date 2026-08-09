import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test-e2e',
  globalSetup: './test-e2e/global-setup.mjs',
  globalTeardown: './test-e2e/global-teardown.mjs',
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:2699',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
