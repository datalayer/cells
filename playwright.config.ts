/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { defineConfig } from '@playwright/test';

// The system Chrome, headless, one worker: the machine downloads no
// Playwright browser, and browser suites run one at a time.
export default defineConfig({
  testDir: 'e2e',
  // The screenshot suite (e2e/screenshots.spec.ts) compares against CI's own screenshots, kept in
  // e2e/__screenshots__; CELLS_SCREENSHOTS_WRITE=1 writes them afresh, and a missing one fails.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  updateSnapshots: process.env.CELLS_SCREENSHOTS_WRITE === '1' ? 'all' : 'none',
  workers: 1,
  fullyParallel: false,
  webServer: {
    command: 'node scripts/examples.mjs',
    url: 'http://127.0.0.1:3077',
    // A server already on the port (make examples) is used as it is.
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:3077',
    headless: true,
    // A page's heap is capped, so a runaway page crashes its tab, not the machine.
    launchOptions: {
      executablePath: process.env.CELLS_CHROME ?? '/usr/bin/google-chrome',
      args: ['--js-flags=--max-old-space-size=2048'],
    },
  },
});
