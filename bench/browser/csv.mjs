/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The CSV budget (C5-01): a file of a million rows of ten columns (numbers
 * and words) imported through the worker into a model, the time it takes and
 * the longest main-thread task meanwhile. `CELLS_CSV_ROWS` makes it smaller
 * for a smoke run.
 */

import { benchPage, traceTasks } from './trace.mjs';

const PORT = 3080;

/** @param {import('@playwright/test').Browser} browser */
export async function run(browser) {
  const rows = Number(process.env.CELLS_CSV_ROWS ?? 1_000_000);
  const server = await benchPage(PORT);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.waitForFunction(() => 'cellsBench' in window);
    await page.evaluate((n) => window.cellsBench.csvFile(n), rows);
    let result;
    const { tasks } = await traceTasks(page, async () => {
      result = await page.evaluate(() => window.cellsBench.csvImport());
    });
    await context.close();
    if (errors.length > 0) throw new Error(`The CSV bench page failed: ${errors.join('; ')}`);
    if (result.cells !== rows * 10)
      throw new Error(`${result.cells} cells imported, not ${rows * 10}.`);
    if (process.env.CELLS_BENCH_VERBOSE)
      console.error(
        'csv',
        rows,
        result,
        tasks.length,
        tasks.map((t, i) => [i, Math.round(t)]).filter(([, t]) => t > 20),
      );
    return {
      'csv.import1m.ms': { value: Math.round(result.ms), unit: 'ms', runs: 1 },
      'csv.import1m.maxBlockMs': {
        value: Math.round(Math.max(...tasks) * 10) / 10,
        unit: 'ms',
        runs: 1,
      },
    };
  } finally {
    await server.close();
  }
}
