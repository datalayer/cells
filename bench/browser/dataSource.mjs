/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The data-source figures (C7-03): a synthetic source of ten million rows ×
 * 12 columns bound at A1, its pages answered after a server's delay, scrolled
 * at 1920×1080 and DPR 2 with the scroll budget of §4: the script time per
 * frame while wheeling down through pages that arrive on demand, and the
 * frames of a 10-second fling (bench/fling.mjs). Then a jump to the far end, whose last
 * row must arrive. `CELLS_SOURCE_ROWS` makes it smaller for a smoke run.
 */

import { flingFigures } from '../fling.mjs';
import { benchPage, percentile, traceTasks } from './trace.mjs';

const PORT = 3081;
const DELAY_MS = 30;

/** @param {import('@playwright/test').Browser} browser */
export async function run(browser) {
  const rows = Number(process.env.CELLS_SOURCE_ROWS ?? 10_000_000);
  const server = await benchPage(PORT);
  const figures = {};
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.waitForFunction(() => 'cellsBench' in window);
    await page.evaluate(([n, d]) => window.cellsBench.dataSource(n, d), [rows, DELAY_MS]);
    const grid = page.getByRole('grid');
    await grid.focus();
    const box = await grid.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const fetchesBefore = (await page.evaluate(() => window.cellsBench.dataSourceStats())).fetches;

    // Wheel down through the source as the grid's own bench does (120 px a tick): script per frame,
    // pages arriving on the way.
    const runs = [];
    for (let run = 0; run < 5; run += 1) {
      const { tasks } = await traceTasks(page, async () => {
        for (let i = 0; i < 60; i += 1) {
          await page.mouse.wheel(0, 120);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        }
      });
      runs.push(percentile(tasks, 95));
    }
    figures['dataSource.scrollFrame.jsMs'] = {
      value: round(percentile(runs, 95)),
      unit: 'ms',
      runs: runs.length,
    };

    // A 10-second fling, 240 px a frame as the grid's own (grid.mjs): a page of rows about every
    // 90 frames, each asked for as it comes into view.
    const fling = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const scroller = document.querySelector('[data-cells-scroller]');
          const deltas = [];
          let last = performance.now();
          const end = last + 10_000;
          const step = (now) => {
            deltas.push(now - last);
            last = now;
            scroller.scrollTop += 240;
            if (now < end) requestAnimationFrame(step);
            else resolve(deltas.slice(2));
          };
          requestAnimationFrame(step);
        }),
    );
    Object.assign(figures, flingFigures('dataSource.scrollFling', fling));

    // The far end: its page is asked for on demand and its last row arrives.
    await page
      .locator('[data-cells-scroller]')
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page
      .getByRole('gridcell', { name: `row ${rows}`, exact: true })
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 });
    const stats = await page.evaluate(() => window.cellsBench.dataSourceStats());
    const fetched = stats.fetches - fetchesBefore;
    if (fetched < 3)
      throw new Error(`Scrolling fetched ${fetched} pages: rows did not arrive on demand.`);
    if (stats.failed > 0) throw new Error(`${stats.failed} pages failed.`);
    if (process.env.CELLS_BENCH_VERBOSE) console.error('data source', rows, stats);
    await context.close();
    if (errors.length > 0)
      throw new Error(`The data source bench page failed: ${errors.join('; ')}`);
  } finally {
    await server.close();
  }
  return figures;
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
