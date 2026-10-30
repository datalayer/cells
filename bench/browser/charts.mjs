/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The charts' browser figures (§4, C10-10), at 1920×1080 and DPR 2 on the
 * examples' bench page (examples/bench.html), on its own dev server:
 *
 * - `charts.editToPaint.ms`: an edit inside the range of a 1,000-point line
 *   chart, from the commit to the frame after ECharts drew an option holding
 *   the new value; p95 of ten edits.
 * - `charts.scroll20.jsMs`: twenty charts on a sheet, the script time per
 *   frame while wheeling down past them as the grid's own bench does (60
 *   ticks of 120 px), the charts mounting as they come into view; p95 of five
 *   runs' p95, each run from the top.
 */

import { benchPage, percentile, traceTasks } from './trace.mjs';

const PORT = 3083;
const POINTS = 1_000;
const CHARTS = 20;

/** @param {import('@playwright/test').Browser} browser */
export async function run(browser) {
  const server = await benchPage(PORT);
  const figures = {};
  try {
    const open = async () => {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(server.url);
      await page.waitForFunction(() => 'cellsBench' in window);
      return { context, page, errors };
    };

    // An edit under a 1,000-point line chart, to the chart's next frame.
    {
      const { context, page, errors } = await open();
      await page.evaluate((n) => window.cellsBench.lineChart(n), POINTS);
      const edits = [];
      for (let run = 0; run < 10; run += 1) {
        const value = 9000 + run + 0.25;
        edits.push(
          await page.evaluate(
            ([row, v]) => window.cellsBench.chartEdit(row, v),
            [100 + run, value],
          ),
        );
      }
      figures['charts.editToPaint.ms'] = {
        value: round(percentile(edits, 95)),
        unit: 'ms',
        runs: edits.length,
      };
      if (process.env.CELLS_BENCH_VERBOSE) console.error('chart edits', edits);
      await context.close();
      if (errors.length > 0) throw new Error(`The chart page failed: ${errors.join('; ')}`);
    }

    // Twenty charts on a sheet, scrolled past.
    {
      const { context, page, errors } = await open();
      const count = await page.evaluate((n) => window.cellsBench.chartsSheet(n), CHARTS);
      if (count !== CHARTS) throw new Error(`The sheet holds ${count} charts, not ${CHARTS}.`);
      const grid = page.getByRole('grid');
      await grid.focus();
      const box = await grid.boundingBox();
      // Over the figures in A:D, not over a chart.
      await page.mouse.move(box.x + 250, box.y + box.height / 2);
      const runs = [];
      const drawn = new Set();
      for (let run = 0; run < 5; run += 1) {
        await page.locator('[data-cells-scroller]').evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.evaluate(
          () =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
        );
        const { tasks } = await traceTasks(page, async () => {
          for (let i = 0; i < 60; i += 1) {
            await page.mouse.wheel(0, 120);
            const ids = await page.evaluate(
              () =>
                new Promise((r) => requestAnimationFrame(() => r(window.cellsBench.chartsDrawn()))),
            );
            for (const id of ids) drawn.add(id);
          }
        });
        runs.push(percentile(tasks, 95));
        if (process.env.CELLS_BENCH_VERBOSE)
          console.error(
            'scrolled to',
            await page.locator('[data-cells-scroller]').evaluate((el) => el.scrollTop),
            'charts drawn so far',
            drawn.size,
          );
      }
      // Scrolling passed them all: each was drawn on the way.
      if (drawn.size !== CHARTS)
        throw new Error(
          `${drawn.size} of the ${CHARTS} charts were drawn while scrolling past them.`,
        );
      figures['charts.scroll20.jsMs'] = {
        value: round(percentile(runs, 95)),
        unit: 'ms',
        runs: runs.length,
      };
      if (process.env.CELLS_BENCH_VERBOSE)
        console.error('charts scroll', runs, 'drawn', drawn.size);
      await context.close();
      if (errors.length > 0) throw new Error(`The charts sheet failed: ${errors.join('; ')}`);
    }
  } finally {
    await server.close();
  }
  return figures;
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
