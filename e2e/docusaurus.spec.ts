/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * C7-06: the Docusaurus sample site (`integrations/docusaurus/site`), built
 * (`npm run install:local && npm run build` there), served as static files
 * and opened in Chrome: its page shows two live sheets, the workbook checked
 * at build with its formulas computed in the browser, and the CSV file read
 * from the site's static files. CI builds the site first and sets
 * `CELLS_DOCUSAURUS_SITE=1`, so a missing build fails there instead of skipping.
 */

const BUILD = fileURLToPath(new URL('../integrations/docusaurus/site/build', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};

let server: Server;
let origin = '';

test.beforeAll(async () => {
  if (!existsSync(join(BUILD, 'index.html'))) {
    if (process.env.CELLS_DOCUSAURUS_SITE === '1')
      throw new Error(`The sample site is not built: ${BUILD} has no index.html.`);
    return;
  }
  server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
    let file = join(BUILD, path);
    if (!file.startsWith(BUILD)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
test.afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
});

test('the sample Docusaurus site shows a live sheet', async ({ page }) => {
  test.skip(origin === '', 'The sample site is not built (integrations/docusaurus/site).');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { name: 'A live sheet in a page' })).toBeVisible();

  // The workbook: its formulas are computed in the browser (3 × 0.50 + 2 × 0.75 + 12 × 0.20).
  const budget = page.getByRole('grid', { name: 'Budget' });
  await expect(budget).toBeVisible();
  await expect(budget.getByRole('gridcell', { name: 'Apples', exact: true })).toHaveCount(1);
  await expect(
    budget.getByRole('gridcell', { name: '5.40, formula: =SUM(D2:D4)', exact: true }),
  ).toHaveCount(1);
  // The grid is live: it takes the focus and the keyboard moves through it.
  await budget.focus();
  await page.keyboard.press('Control+End');
  const active = await budget.getAttribute('aria-activedescendant');
  expect(await page.locator(`[id="${active}"]`).textContent()).toBe('5.40, formula: =SUM(D2:D4)');
  // It is read-only on the site (the plugin's `editable: false`): typing changes nothing.
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('9');
  await page.keyboard.press('Enter');
  await expect(budget.getByRole('gridcell', { name: 'Item', exact: true })).toHaveCount(1);

  // The CSV file, fetched from the site's static files and read in the browser.
  const sales = page.getByRole('grid', { name: 'Sales' });
  await expect(sales.getByRole('gridcell', { name: 'North', exact: true })).toHaveCount(1);
  await expect(sales.getByRole('gridcell', { name: 'Jan', exact: true })).toHaveCount(1);
  // The canvas is painted: some pixel of the grid is not the background.
  const painted = await sales.evaluate((el) => {
    const c = el.querySelector('canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  });
  expect(painted).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});
