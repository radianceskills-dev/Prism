import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 20000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', channel: 'msedge', headless: true },
});
