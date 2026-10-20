const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  timeout: 90000,
  expect: { timeout: 15000 },
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:8080', browserName: 'chromium', channel: process.env.CI ? undefined : 'chrome' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:8080', reuseExistingServer: !process.env.CI },
  reporter: 'list'
});
