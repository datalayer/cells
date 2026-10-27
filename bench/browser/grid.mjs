/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The grid's browser figures (C2-02): first paint with a million cells in the
 * model, the script time per frame while scrolling a screen of text, the
 * longest frame of a 10-second fling, Ctrl+End on a million rows, and a
 * selection move. Runs the examples' bench page (examples/bench.html) on its
 * own dev server, at 1920×1080 and DPR 2.
 */

import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { percentile, traceTasks } from './trace.mjs';

const PORT = 3078;

/** @param {import('@playwright/test').Browser} browser */
export async function run(browser) {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../../examples/vite.config.ts', import.meta.url)),
    server: { port: PORT, strictPort: true },
    logLevel: 'error',
  });
  await server.listen();
  const figures = {};
  try {
    const open = async (fixture) => {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/bench.html`);
      await page.waitForFunction(() => 'cellsBench' in window);
      const timings = await page.evaluate((f) => window.cellsBench.mount(f), fixture);
      await page.getByRole('grid').focus();
      return { context, page, timings };
    };

    // First paint, a million cells in the model; five runs.
    const paints = [];
    for (let i = 0; i < 5; i += 1) {
      const { context, timings } = await open('mixed100k');
      paints.push(timings.firstPaintMs);
      await context.close();
    }
    figures['firstPaint.ms'] = {
      value: round(percentile(paints, 95)),
      unit: 'ms',
      runs: paints.length,
    };

    // A screen full of text: script per frame while scrolling, and a 10-second fling.
    {
      const { context, page } = await open('text100k');
      const box = await page.getByRole('grid').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
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
      if (process.env.CELLS_BENCH_VERBOSE)
        console.error(
          'after scroll',
          await page.evaluate(() => window.cellsBench.handle().renderStats()),
        );
      figures['scrollFrame.jsMs'] = {
        value: round(percentile(runs, 95)),
        unit: 'ms',
        runs: runs.length,
      };
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
      figures['scrollFling.maxFrameMs'] = {
        value: round(Math.max(...fling)),
        unit: 'ms',
        runs: fling.length,
      };

      // A selection move repaints the overlay only.
      const moves = [];
      for (let run = 0; run < 5; run += 1) {
        const { tasks } = await traceTasks(page, async () => {
          for (let i = 0; i < 20; i += 1) {
            await page.keyboard.press(i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
          }
        });
        moves.push(percentile(tasks, 95));
      }
      if (process.env.CELLS_BENCH_VERBOSE)
        console.error(
          'after moves',
          await page.evaluate(() => window.cellsBench.handle().renderStats()),
        );
      figures['selectionMove.ms'] = {
        value: round(percentile(moves, 95)),
        unit: 'ms',
        runs: moves.length,
      };

      // Input latency, from the Event Timing API (what INP reads): a keydown's duration runs from the
      // key to the next paint. Events under its 16 ms floor are not reported; they count as 16.
      await page.evaluate(() => {
        window.__events = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            window.__events.push({ name: e.name, duration: e.duration, id: e.interactionId });
        }).observe({ type: 'event', durationThreshold: 16, buffered: false });
        window.__keydowns = { chars: 0, enters: 0 };
        document.addEventListener(
          'keydown',
          (e) => {
            if (e.key === 'Enter') window.__keydowns.enters += 1;
            else if (e.key.length === 1) window.__keydowns.chars += 1;
          },
          { capture: true },
        );
      });
      for (let run = 0; run < 10; run += 1) {
        await page.keyboard.press('ArrowDown');
        await page.keyboard.type('latency');
        await page.keyboard.press('Enter');
        await page.evaluate(
          () =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
        );
      }
      await page.waitForTimeout(500);
      const { events, keydowns } = await page.evaluate(() => ({
        events: window.__events,
        keydowns: window.__keydowns,
      }));
      const keydownEvents = events.filter((e) => e.name === 'keydown');
      // Enter's keydowns are the slowest of a run (they commit); the rest are characters.
      const sorted = keydownEvents.map((e) => e.duration).sort((a, b) => b - a);
      const enterDurations = sorted.slice(0, Math.min(keydowns.enters, sorted.length));
      const charDurations = sorted.slice(enterDurations.length);
      const pad = (list, n) => [
        ...list,
        ...Array.from({ length: Math.max(0, n - list.length) }, () => 16),
      ];
      figures['input.keystrokeMs'] = {
        value: round(percentile(pad(charDurations, keydowns.chars), 95)),
        unit: 'ms',
        runs: keydowns.chars,
      };
      figures['input.commitMs'] = {
        value: round(percentile(pad(enterDurations, keydowns.enters), 95)),
        unit: 'ms',
        runs: keydowns.enters,
      };
      await context.close();
    }

    // Ctrl+End on a million rows: frames from the key to the last row painted.
    {
      const { context, page } = await open('numeric1m');
      const jumps = [];
      for (let run = 0; run < 5; run += 1) {
        await page.keyboard.press('Control+Home');
        await page.evaluate(
          () =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
        );
        const counting = page.evaluate(
          () =>
            new Promise((resolve) => {
              const grid = document.querySelector('[role="grid"]');
              let frames = 0;
              const tick = () => {
                frames += 1;
                const id = grid.getAttribute('aria-activedescendant') ?? '';
                if (id.includes('-r999999-')) requestAnimationFrame(() => resolve(frames));
                else if (frames > 120) resolve(Infinity);
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
        );
        await page.keyboard.press('Control+End');
        jumps.push(await counting);
      }
      figures['jumpScroll.frames'] = {
        value: percentile(jumps, 95),
        unit: 'frames',
        runs: jumps.length,
      };
      await context.close();
    }
  } finally {
    await server.close();
  }
  return figures;
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
