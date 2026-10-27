/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The browser harness's own figure: 60 animation frames that do nothing,
 * traced. Its p95 task is what the harness costs before any grid is drawn.
 */

import { percentile, traceTasks } from './trace.mjs';

/** @param {import('@playwright/test').Browser} browser */
export async function run(browser) {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>noop</title><body></body>');
  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    const { tasks } = await traceTasks(page, () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            let n = 0;
            const tick = () => (++n < 60 ? requestAnimationFrame(tick) : resolve(n));
            requestAnimationFrame(tick);
          }),
      ),
    );
    runs.push(percentile(tasks, 95));
  }
  await page.close();
  return {
    'harness.browserNoopTask.ms': { value: percentile(runs, 95), unit: 'ms', runs: runs.length },
  };
}
