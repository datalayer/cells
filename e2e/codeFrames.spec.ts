/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';

/**
 * C11-05: the output frames of code cells, in Chrome. The Code cells page
 * keeps its cells' last outputs between visits (localStorage); seeded with a
 * plot (C4, a PNG) and a table (C6, a DataFrame's text) and their frames, it
 * draws both beside their cells from the stored outputs, with no kernel. The
 * frames scroll with their cells under frozen panes and are clipped by their
 * pane, and they come back after the page is left and opened again, still
 * without a run: no kernel or session is ever asked for.
 */

/** A PNG of `w`×`h`: three bars on white, as a small plot would be. */
function png(w: number, h: number): string {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3, 0xff);
    row[0] = 0;
    for (let x = 0; x < w; x += 1) {
      const bar = Math.floor(x / (w / 3));
      const top = h - ((bar + 1) * h) / 4;
      if (y >= top && x % (w / 3) > 8) {
        row[1 + x * 3] = 0x09;
        row[2 + x * 3] = 0x69;
        row[3 + x * 3] = 0xda;
      }
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const TABLE = [
  '  Month  Units  Double',
  '0   Jan     12      24',
  '1   Feb     15      30',
  '2   Mar     19      38',
].join('\n');

const KEPT = {
  C4: {
    frame: { width: 240, height: 110 },
    outputs: [
      {
        output_type: 'display_data',
        data: { 'image/png': png(180, 90), 'text/plain': '<Figure size 420x260>' },
        metadata: {},
      },
    ],
    result: null,
    executionCount: 3,
    lastRun: '2026-10-29T09:00:00.000Z',
  },
  C6: {
    frame: { width: 300, height: 120 },
    outputs: [
      {
        output_type: 'execute_result',
        execution_count: 4,
        data: { 'text/plain': TABLE },
        metadata: {},
      },
    ],
    result: TABLE,
    executionCount: 4,
    lastRun: '2026-10-29T09:00:01.000Z',
  },
};

const frame = (page: Page, ref: string) => page.locator(`[data-cells-code-output="${ref}"]`);

test('a plot and a table render beside their cells from stored outputs, scroll under frozen panes, and remount without a run', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const kernelCalls: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/(kernels|sessions)|prod1\.datalayer/.test(r.url())) kernelCalls.push(r.url());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((kept) => {
    if (sessionStorage.getItem('seeded') === null) {
      localStorage.setItem('cells-examples-code-cells:code-cells', JSON.stringify(kept));
      sessionStorage.setItem('seeded', '1');
    }
  }, KEPT);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/#/code-cells');
  const grid = page.getByRole('grid').first();
  await grid.waitFor();

  // Both frames, beside their cells, drawn by jupyter-react's Output from the stored outputs.
  const plot = frame(page, 'C4');
  const table = frame(page, 'C6');
  await expect(plot).toHaveAccessibleName('Output of C4');
  await expect(table).toHaveAccessibleName('Output of C6');
  const img = plot.locator('img');
  await expect(img).toBeVisible({ timeout: 60_000 });
  expect(await img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(180);
  await expect(table).toContainText('Double', { timeout: 60_000 });
  await expect(table).toContainText('38');
  await expect(page.locator('[data-code-status]')).toContainText('C4: run 3 at');

  // Beside their cells: each frame's left edge is column C's right edge, C4's top above C6's.
  const p0 = (await plot.boundingBox())!;
  const t0 = (await table.boundingBox())!;
  expect(Math.abs(p0.x - t0.x)).toBeLessThanOrEqual(1);
  expect(t0.y - p0.y).toBeGreaterThan(30);

  // Freeze up to C2 (rows 1, columns A–B), from the keyboard: the frames stay in the main pane.
  await grid.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: /^Freeze up to the active cell/ }).click();
  await expect(page.locator('[data-cells-code-pane="main"]')).toHaveCount(1);

  // Scrolled down: both frames move up with their cells, by the same amount, and not sideways.
  const scroller = page.locator('[data-cells-scroller]').first();
  await scroller.evaluate((el) => el.scrollTo({ top: 30 }));
  await expect.poll(async () => p0.y - (await plot.boundingBox())!.y).toBeGreaterThan(10);
  const moved = p0.y - (await plot.boundingBox())!.y;
  expect(Math.abs(t0.y - (await table.boundingBox())!.y - moved)).toBeLessThanOrEqual(1);
  expect(Math.abs((await plot.boundingBox())!.x - p0.x)).toBeLessThanOrEqual(1);

  // Scrolled further, C4's frame passes under the frozen row: its pane clips it there.
  await scroller.evaluate((el) => el.scrollTo({ top: 70 }));
  const pane = (await page.locator('[data-cells-code-pane="main"]').boundingBox())!;
  const clipped = (await plot.boundingBox())!;
  expect(clipped.y).toBeLessThan(pane.y);
  const atTop = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-cells-code-output]') !== null,
    [clipped.x + 20, (clipped.y + pane.y) / 2],
  );
  expect(atTop).toBe(false);
  const below = await page.evaluate(
    ([x, y]) =>
      document
        .elementFromPoint(x, y)
        ?.closest('[data-cells-code-output]')
        ?.getAttribute('data-cells-code-output') ?? null,
    [clipped.x + 20, pane.y + 6],
  );
  expect(below).toBe('C4');

  // Left and opened again: the frames are drawn again from what was kept, still not run.
  await page.goto('/#/minimal');
  await page.getByRole('grid').first().waitFor();
  await page.goto('/#/code-cells');
  await expect(frame(page, 'C4').locator('img')).toBeVisible({ timeout: 60_000 });
  await expect(frame(page, 'C6')).toContainText('Double');
  await expect(page.locator('[data-code-status]')).toContainText('C4: run 3 at');
  await expect(page.locator('[data-code-status]')).toContainText('C6: run 4 at');
  expect(kernelCalls).toEqual([]);
  expect(errors).toEqual([]);
});
