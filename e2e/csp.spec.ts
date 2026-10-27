/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

/**
 * C4-02: formulas evaluate on a page with `script-src 'self'`. The compiler
 * builds closures, never `eval` or `new Function`; the page proves its policy
 * holds by failing to call `new Function` itself.
 */
test('evaluates formulas under script-src self', async ({ page }) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./csp/entry.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  const script = bundle.outputFiles[0].text;
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') violations.push(m.text());
  });
  await page.route('http://csp.cells.test/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/app.js')
      return route.fulfill({ contentType: 'text/javascript', body: script });
    return route.fulfill({
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': "script-src 'self'; object-src 'none'" },
      body: '<!doctype html><html><body><script type="module" src="/app.js"></script></body></html>',
    });
  });
  await page.goto('http://csp.cells.test/');
  await expect(page.locator('body[data-result]')).toBeAttached();
  const result = JSON.parse((await page.locator('body').getAttribute('data-result'))!);
  expect(result).toEqual({ evalBlocked: true, values: [3, 5, 6] });
  // The only violation is the page's own probe of new Function.
  expect(violations.filter((v) => !/unsafe-eval|EvalError|Function/.test(v))).toEqual([]);
});
