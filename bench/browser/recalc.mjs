/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The deep recalculation in the browser (C4-03): editing the head of a
 * 100,000-long chain of formulas on screen, the longest main-thread task until
 * the background recalculation is done. Runs the examples' bench page on its
 * own dev server.
 */

import { benchPage, traceTasks } from './trace.mjs';

const PORT = 3079;

/** @param {import('@playwright/test').Browser} browser */
export async function run(browser) {
  const server = await benchPage(PORT);
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForFunction(() => 'cellsBench' in window);
    await page.evaluate(() => window.cellsBench.chain(100_000));
    const longest = [];
    for (let run = 0; run < 5; run += 1) {
      const { tasks } = await traceTasks(page, () =>
        page.evaluate((v) => window.cellsBench.edit(v), run + 2),
      );
      longest.push(Math.max(...tasks));
    }
    await context.close();
    return {
      'recalc.deep.maxTaskMs': {
        value: Math.round(Math.max(...longest) * 1000) / 1000,
        unit: 'ms',
        runs: longest.length,
      },
    };
  } finally {
    await server.close();
  }
}
