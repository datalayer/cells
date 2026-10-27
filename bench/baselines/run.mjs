/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Baselines: the bench fixtures loaded in the two reference spreadsheets, so
 * "fast" is a claim measured against something. Writes
 * `bench/results/baselines.json`.
 *
 * Neither reference is a dependency, and no code of either is copied: their
 * published builds are loaded into a page at run time, from directories the
 * caller names.
 *
 *     CELLS_OSPREADSHEET_DIR=<o-spreadsheet package dir, with dist/>  \
 *     CELLS_OWL_DIR=<@odoo/owl package dir, with dist/>               \
 *     CELLS_XSPREADSHEET_DIR=<x-spreadsheet checkout, with dist/>     \
 *     env -u WAYLAND_DISPLAY -u DISPLAY node bench/baselines/run.mjs
 *
 * (`npm pack @odoo/o-spreadsheet@<v> @odoo/owl@<v>` gives the first two.)
 * The page's heap is capped, so a reference that cannot hold a fixture fails
 * in its tab, not on the machine; that failure is recorded as a note.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { CHROME, percentile, traceTasks } from '../browser/trace.mjs';
import { FIXTURES } from '../fixtures/fixtures.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}; see the head of bench/baselines/run.mjs.`);
  return value;
};
const O_DIR = need('CELLS_OSPREADSHEET_DIR');
const OWL_DIR = need('CELLS_OWL_DIR');
const X_DIR = need('CELLS_XSPREADSHEET_DIR');
if (process.env.WAYLAND_DISPLAY || process.env.DISPLAY) {
  throw new Error('Run with `env -u WAYLAND_DISPLAY -u DISPLAY` so Chrome stays headless.');
}

const ORIGIN = 'http://baselines.local';
const HEAP_MB = 3072;
const VIEWPORT = { width: 1920, height: 1080 };

/** The fixture as the page reads it: numbers as Float64, formulas as JSON text. */
function fixtureBody(name) {
  const f = FIXTURES[name];
  const numeric = typeof f.cell(0, 1) === 'number' && typeof f.cell(1, 2) === 'number';
  if (numeric) {
    const values = new Float64Array(f.rows * f.cols);
    for (let r = 0; r < f.rows; r += 1)
      for (let c = 0; c < f.cols; c += 1) values[r * f.cols + c] = f.cell(r, c);
    return { contentType: 'application/octet-stream', body: Buffer.from(values.buffer) };
  }
  const rows = [];
  for (let r = 0; r < f.rows; r += 1) {
    const row = [];
    for (let c = 0; c < f.cols; c += 1) row.push(f.cell(r, c));
    rows.push(row);
  }
  return { contentType: 'application/json', body: JSON.stringify(rows) };
}

const FILES = {
  '/owl.js': join(OWL_DIR, 'dist/owl.iife.js'),
  '/o.js': join(O_DIR, 'dist/o-spreadsheet.iife.js'),
  '/o.xml': join(O_DIR, 'dist/o_spreadsheet.xml'),
  '/x.js': join(X_DIR, 'dist/xspreadsheet.js'),
  '/x.css': join(X_DIR, 'dist/xspreadsheet.css'),
};

async function newPage(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await context.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/fixture/')) {
      const { contentType, body } = fixtureBody(path.slice('/fixture/'.length));
      return route.fulfill({ status: 200, contentType, body });
    }
    if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    const file = FILES[path];
    if (!file) return route.fulfill({ status: 404, body: 'not found' });
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : 'text/xml';
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  return { page, context };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>baselines</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#host{position:absolute;inset:0}</style>
<link rel="stylesheet" href="/x.css"></head><body><div id="host"></div>
<script src="/owl.js"></script><script src="/o.js"></script><script src="/x.js"></script>
<script>
window.letters = (c) => { let s = ''; let n = c + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
window.loadFixture = async (name, rows, cols) => {
  const res = await fetch('/fixture/' + name);
  if (res.headers.get('content-type').includes('json')) return { kind: 'text', rows: await res.json(), nRows: rows, nCols: cols };
  return { kind: 'numbers', values: new Float64Array(await res.arrayBuffer()), nRows: rows, nCols: cols };
};
window.cellAt = (f, r, c) => f.kind === 'numbers' ? f.values[r * f.nCols + c] : f.rows[r][c];
window.frames = (n) => new Promise((res) => { let i = 0; const t = () => (++i < n ? requestAnimationFrame(t) : res()); requestAnimationFrame(t); });

window.buildO = (f) => {
  const cells = {};
  for (let r = 0; r < f.nRows; r++) for (let c = 0; c < f.nCols; c++) {
    const v = cellAt(f, r, c); if (v === null) continue;
    cells[letters(c) + (r + 1)] = { content: String(v) };
  }
  return { version: 10, sheets: [{ name: 'Sheet1', colNumber: Math.max(26, f.nCols), rowNumber: f.nRows + 1, cells }] };
};
window.mountO = async (data) => {
  const templates = await (await fetch('/o.xml')).text();
  const model = new o_spreadsheet.Model(data);
  class Root extends owl.Component {}
  Root.template = owl.xml\`<div style="position:absolute;inset:0"><Spreadsheet model="props.model"/></div>\`;
  Root.components = { Spreadsheet: o_spreadsheet.Spreadsheet };
  const app = new owl.App(Root, { props: { model }, templates });
  await app.mount(document.getElementById('host'));
  window.oModel = model;
  return model;
};
window.buildX = (f) => {
  const rows = { len: f.nRows };
  for (let r = 0; r < f.nRows; r++) { const cells = {};
    for (let c = 0; c < f.nCols; c++) { const v = cellAt(f, r, c); if (v !== null) cells[c] = { text: String(v) }; }
    rows[r] = { cells }; }
  return { name: 'sheet1', rows };
};
window.mountX = (data, f) => {
  const s = x.spreadsheet('#host', { showToolbar: false, showBottomBar: false, row: { len: f.nRows, height: 25 }, col: { len: Math.max(26, f.nCols), width: 100, indexWidth: 60, minWidth: 60 }, view: { height: () => window.innerHeight, width: () => window.innerWidth } });
  s.loadData(data);
  window.xSheet = s;
  return s;
};
</script></body></html>`;

async function heapUsed(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  await cdp.detach();
  return usedSize;
}

/** Scripted wheel scroll over `selector`: 60 steps of 120 px, one per frame. */
async function scrollFrames(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Nothing to scroll: ${selector} is not on the page.`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const runs = [];
  for (let run = 0; run < 5; run += 1) {
    const { tasks } = await traceTasks(page, async () => {
      for (let i = 0; i < 60; i += 1) {
        await page.mouse.wheel(0, run % 2 === 0 ? 120 : -120);
        await page.evaluate(() => window.frames(1));
      }
    });
    runs.push(percentile(tasks, 95));
  }
  return { value: percentile(runs, 95), unit: 'ms', runs: runs.length };
}

async function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took more than ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function measureLoad(browser, which, name) {
  const f = FIXTURES[name];
  const { page, context } = await newPage(browser);
  try {
    const before = await heapUsed(page);
    const loadMs = await withTimeout(
      page.evaluate(
        async ({ which, name, rows, cols }) => {
          const f = await window.loadFixture(name, rows, cols);
          const t0 = performance.now();
          if (which === 'o') await window.mountO(window.buildO(f));
          else window.mountX(window.buildX(f), f);
          await window.frames(2);
          const ms = performance.now() - t0;
          window.fixtureData = null;
          return ms;
        },
        { which, name, rows: f.rows, cols: f.cols },
      ),
      300_000,
      `${which} loading ${name}`,
    );
    const after = await heapUsed(page);
    const figures = {
      'load.ms': { value: Math.round(loadMs), unit: 'ms' },
      'memory.bytesPerCell': { value: Math.round((after - before) / f.filled), unit: 'B' },
    };
    figures['scrollFrame.jsMs'] = await withTimeout(
      scrollFrames(page, which === 'o' ? '.o-grid' : '.x-spreadsheet-overlayer'),
      300_000,
      `${which} scrolling ${name}`,
    );
    return figures;
  } finally {
    await context.close();
  }
}

/** o-spreadsheet only: full evaluation of the formula fixture, then a deep edit. */
async function measureRecalc(browser) {
  const f = FIXTURES.formulas100k;
  const { page, context } = await newPage(browser);
  try {
    return await withTimeout(
      page.evaluate(
        async ({ rows, cols }) => {
          const fx = await window.loadFixture('formulas100k', rows, cols);
          const data = window.buildO(fx);
          const t0 = performance.now();
          const model = new o_spreadsheet.Model(data);
          const sheetId = model.getters.getActiveSheetId();
          model.getters.getEvaluatedCell({ sheetId, col: 9, row: rows - 1 });
          const full = performance.now() - t0;
          const t1 = performance.now();
          model.dispatch('UPDATE_CELL', { sheetId, col: 0, row: 0, content: '7' });
          model.getters.getEvaluatedCell({ sheetId, col: 1, row: rows - 1 });
          const deep = performance.now() - t1;
          return {
            'recalc.full.ms': { value: Math.round(full), unit: 'ms' },
            'recalc.deep.ms': { value: Math.round(deep), unit: 'ms' },
          };
        },
        { rows: f.rows, cols: f.cols },
      ),
      300_000,
      'o-spreadsheet recalculating formulas100k',
    );
  } finally {
    await context.close();
  }
}

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const wanted = (name) => only === '' || only.split(',').includes(name);
const path = join(ROOT, 'bench/results/baselines.json');

/** Kept from an earlier run when only some measurements are taken again. */
let previous = null;
if (only !== '') {
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    previous = null;
  }
}

const result = {
  version: 1,
  date: new Date().toISOString().slice(0, 10),
  conditions: `system Chrome headless, ${VIEWPORT.width}x${VIEWPORT.height} at DPR 2, page heap capped at ${HEAP_MB} MB, a fresh browser per measurement; scroll frame is the p95 main-thread task over 5 runs of 60 wheel steps`,
  references: {
    oSpreadsheet: JSON.parse(readFileSync(join(O_DIR, 'package.json'), 'utf8')).version,
    xSpreadsheet: JSON.parse(readFileSync(join(X_DIR, 'package.json'), 'utf8')).version,
  },
  oSpreadsheet: { ...(previous?.oSpreadsheet ?? {}) },
  xSpreadsheet: { ...(previous?.xSpreadsheet ?? {}) },
  // Notes of measurements not taken again are kept.
  notes: (previous?.notes ?? []).filter(
    (n) =>
      !only.split(',').some((name) => n.includes(name === 'recalc' ? 'recalc' : ` ${name}`)) &&
      !n.startsWith('x-spreadsheet has no'),
  ),
};

/** One measurement in a browser of its own, so a reference that crashes its tab takes nothing else down. */
async function inBrowser(fn) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [`--js-flags=--max-old-space-size=${HEAP_MB}`],
  });
  try {
    return await fn(browser);
  } finally {
    // A tab that ran out of heap can keep the browser from closing: give it
    // ten seconds, then kill the process.
    const closed = browser.close().then(
      () => true,
      () => false,
    );
    const timedOut = new Promise((resolve) => setTimeout(() => resolve(false), 10_000));
    if (!(await Promise.race([closed, timedOut]))) browser.process?.()?.kill('SIGKILL');
  }
}

for (const name of ['numeric100k', 'mixed100k', 'numeric1m']) {
  if (!wanted(name)) continue;
  for (const [which, key] of [
    ['o', 'oSpreadsheet'],
    ['x', 'xSpreadsheet'],
  ]) {
    try {
      const figures = await inBrowser((browser) => measureLoad(browser, which, name));
      for (const [figure, value] of Object.entries(figures))
        result[key][`${name}.${figure}`] = value;
      console.log(key, name, JSON.stringify(figures));
    } catch (error) {
      const note = `${key} could not be measured on ${name}: ${String(error.message ?? error).split('\n')[0]}`;
      result.notes.push(note);
      console.log(note);
    }
  }
}
if (wanted('recalc')) {
  try {
    Object.assign(result.oSpreadsheet, await inBrowser((browser) => measureRecalc(browser)));
    console.log('oSpreadsheet recalc', JSON.stringify(result.oSpreadsheet));
  } catch (error) {
    result.notes.push(
      `oSpreadsheet recalc could not be measured: ${String(error.message ?? error).split('\n')[0]}`,
    );
  }
}
result.notes.push(
  'x-spreadsheet has no recalculation to measure: it evaluates formulas while painting each visible cell.',
);

writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${path}`);
