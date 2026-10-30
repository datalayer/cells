/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The XLSX budget (C5-02): a workbook of 100,000 rows of ten columns (numbers
 * and words), written by the grid's own writer, read in the XLSX worker and
 * loaded into a model: the time it takes (five runs, p95). The longest
 * main-thread task meanwhile (the model's load, which has no budget) is printed
 * with `CELLS_BENCH_VERBOSE`. `CELLS_XLSX_ROWS` makes it smaller for a smoke run.
 */

import { benchPage, percentile, traceTasks } from './trace.mjs';

const PORT = 3082;

/** @param {import('@playwright/test').Browser} browser */
export async function run(browser) {
  const rows = Number(process.env.CELLS_XLSX_ROWS ?? 100_000);
  const server = await benchPage(PORT);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.waitForFunction(() => 'cellsBench' in window);
    const bytes = await page.evaluate((n) => window.cellsBench.xlsxFile(n), rows);
    const times = [];
    const blocks = [];
    for (let run = 0; run < 5; run += 1) {
      let result;
      const { tasks } = await traceTasks(page, async () => {
        result = await page.evaluate(() => window.cellsBench.xlsxImport());
      });
      if (result.cells !== rows * 10)
        throw new Error(`${result.cells} cells imported, not ${rows * 10}.`);
      times.push(result.ms);
      blocks.push(Math.max(...tasks));
    }
    await context.close();
    if (errors.length > 0) throw new Error(`The XLSX bench page failed: ${errors.join('; ')}`);
    if (process.env.CELLS_BENCH_VERBOSE)
      console.error('xlsx', rows, 'rows,', bytes, 'bytes:', times, 'longest tasks', blocks);
    return {
      'xlsx.import100k.ms': {
        value: Math.round(percentile(times, 95)),
        unit: 'ms',
        runs: times.length,
      },
    };
  } finally {
    await server.close();
  }
}
