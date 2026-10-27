/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Browser bench helpers: the system Chrome through Playwright, and CDP
 * tracing of the renderer's main thread. One browser at a time; the caller
 * closes it.
 */

import { chromium } from '@playwright/test';

/** The system Chrome; the machine downloads no Playwright browser. */
export const CHROME = process.env.CELLS_CHROME ?? '/usr/bin/google-chrome';

/**
 * Launch the system Chrome headless. `WAYLAND_DISPLAY` and `DISPLAY` must be
 * unset by the caller's environment, so no window can open on the desktop.
 */
export async function launch() {
  // The reference figures come from a headed Chrome with its GPU
  // (CELLS_BENCH_HEADED=1, on the reference machine): headless Chrome
  // composites in software, which is not what people see.
  if (process.env.CELLS_BENCH_HEADED === '1') {
    return chromium.launch({ executablePath: CHROME, headless: false });
  }
  if (process.env.WAYLAND_DISPLAY || process.env.DISPLAY) {
    throw new Error(
      'WAYLAND_DISPLAY or DISPLAY is set: run with `env -u WAYLAND_DISPLAY -u DISPLAY` so Chrome stays headless.',
    );
  }
  return chromium.launch({ executablePath: CHROME, headless: true });
}

/**
 * Trace the main thread while `action` runs, and return the durations (ms) of
 * its top-level tasks: what "JS time per frame" and "longest task" are read from.
 *
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} action
 * @returns {Promise<{ tasks: number[], frames: number }>}
 */
export async function traceTasks(page, action) {
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', {
    categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline.frame',
    transferMode: 'ReportEvents',
  });
  await action();
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  const main = mainThread(events);
  const tasks = events
    .filter(
      (e) => TASK_NAMES.has(e.name) && e.ph === 'X' && e.tid === main.tid && e.pid === main.pid,
    )
    .map((e) => e.dur / 1000);
  const frames = events.filter((e) => e.name === 'DrawFrame' || e.name === 'Commit').length;
  return { tasks, frames };
}

/** A top-level task of the main thread, under the names Chrome has used for it. */
const TASK_NAMES = new Set(['RunTask', 'ThreadControllerImpl::RunTask']);

function mainThread(events) {
  const named = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  if (!named) throw new Error('The trace has no renderer main thread (CrRendererMain).');
  return { pid: named.pid, tid: named.tid };
}

/** The p-th percentile (0–100) of `values`, nearest-rank. */
export function percentile(values, p) {
  if (values.length === 0) throw new Error('No value to take a percentile of.');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[rank];
}
