/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const fixture = (name: string) =>
  readFileSync(new URL(`../tests/clipboard/${name}`, import.meta.url), 'utf8');

/** Read a model of the test page, in the page. */
function state<T>(page: Page, which: 'left' | 'right', read: string): Promise<T> {
  return page.evaluate(
    ({ which, read }) =>
      new Function('m', `return ${read}`)(
        (window as never as { cells: Record<string, unknown> }).cells[which],
      ),
    { which, read },
  ) as Promise<T>;
}

/** Put HTML and text on the system clipboard, as another application would. */
async function clipboard(page: Page, html: string, text: string) {
  await page.evaluate(
    async ({ html, text }) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
    },
    { html, text },
  );
}

test.describe('the clipboard (C3-04)', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/e2e.html');
  });

  test("pastes Excel's HTML: values, x:num numbers, booleans, styles and number formats", async ({
    page,
  }) => {
    await clipboard(
      page,
      fixture('excel.html'),
      'Item\tCost\tPaid\nRent\t1,234.50\tTRUE\nFood & drink\t300.00\t15-Mar-23',
    );
    const right = page.getByRole('grid', { name: 'Right grid' });
    await right.click({ position: { x: 118, y: 98 } }); // A4
    await page.keyboard.press('Control+v');
    await expect
      .poll(() => state(page, 'right', 'm.toRows({ top: 3, left: 0, bottom: 5, right: 2 })'))
      .toEqual([
        ['Item', 'Cost', 'Paid'],
        ['Rent', 1234.5, true],
        ['Food & drink', 300, 45000],
      ]);
    expect(await state(page, 'right', "m.style('s1', 3, 0)")).toEqual({ bold: true });
    expect(await state(page, 'right', "m.style('s1', 4, 1)")).toEqual({ format: '#,##0.00' });
    expect(await state(page, 'right', "m.style('s1', 5, 0)")).toEqual({
      color: 'red',
      fill: 'yellow',
    });
    expect(await state(page, 'right', "m.style('s1', 5, 2).format")).toBe('[$-409]d\\-mmm\\-yy;@');
    await expect(right.getByRole('gridcell', { name: '15-Mar-23', exact: true })).toHaveCount(1);
    expect(await state(page, 'right', 'm.historyLabels.undo')).toBe('Paste');
  });

  test("pastes Sheets' HTML: data-sheets-value, its number format, a line break in a cell", async ({
    page,
  }) => {
    await clipboard(page, fixture('sheets.html'), 'Region\tQ1\nNorth\t1,200\n"South\nWest"\t-75.5');
    const right = page.getByRole('grid', { name: 'Right grid' });
    await right.click({ position: { x: 118, y: 98 } });
    await page.keyboard.press('Control+v');
    await expect
      .poll(() => state(page, 'right', 'm.toRows({ top: 3, left: 0, bottom: 5, right: 1 })'))
      .toEqual([
        ['Region', 'Q1'],
        ['North', 1200],
        ['South\nWest', -75.5],
      ]);
    expect(await state(page, 'right', "m.style('s1', 4, 1)")).toEqual({
      fill: '#d9ead3',
      align: 'right',
      format: '#,##0',
    });
    expect(await state(page, 'right', "m.style('s1', 5, 0)")).toEqual({ italic: true });
  });

  test('pastes plain text when there is no HTML', async ({ page }) => {
    await page.evaluate(() => navigator.clipboard.writeText('12\tTRUE\n=A1*2\ttext'));
    const right = page.getByRole('grid', { name: 'Right grid' });
    await right.click({ position: { x: 118, y: 98 } });
    await page.keyboard.press('Control+v');
    // The formula is kept as typed; its value is computed (A1 holds text here).
    await expect.poll(() => state(page, 'right', "m.content('s1', 4, 0)?.formula")).toBe('A1*2');
    expect(await state(page, 'right', "m.value('s1', 3, 1)")).toBe(true);
  });

  test('copies from one grid to another losslessly, and writes text and HTML for other applications', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const m = (window as never as { cells: { left: { dispatch(c: unknown): unknown } } }).cells
        .left;
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 0, left: 0, bottom: 0, right: 1 },
        style: { bold: true, format: '0.00' },
      });
      m.dispatch({
        type: 'SET_CELLS',
        sheet: 's1',
        at: { row: 1, col: 1 },
        cells: [[{ formula: 'A1&"!"' }]],
      });
      m.dispatch({ type: 'MERGE', sheet: 's1', zone: { top: 2, left: 0, bottom: 2, right: 1 } });
    });
    const left = page.getByRole('grid', { name: 'Left grid' });
    await left.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+c');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split('\n')[0]).toBe('A1\tB1');
    const right = page.getByRole('grid', { name: 'Right grid' });
    await right.click({ position: { x: 118, y: 140 } }); // A6
    await page.keyboard.press('Control+v');
    const copied = await state(page, 'left', 'm.copy({ top: 0, left: 0, bottom: 2, right: 1 })');
    const pasted = await state(page, 'right', 'm.copy({ top: 5, left: 0, bottom: 7, right: 1 })');
    // Lossless, but for the formula's relative reference, which moved with it (B2 to B7).
    const parts = (copied as { parts: { cells: { f?: string }[] } }).parts;
    const moved = {
      ...parts,
      cells: parts.cells.map((c) => (c.f === 'A1&"!"' ? { ...c, f: 'A6&"!"' } : c)),
    };
    expect((pasted as { parts: unknown }).parts).toEqual(moved);
    expect(await state(page, 'right', "m.content('s1', 6, 1).formula")).toBe('A6&"!"');
    expect(await state(page, 'right', "m.sheet('s1').merges")).toContainEqual({
      top: 7,
      left: 0,
      bottom: 7,
      right: 1,
    });
  });

  test('cuts and pastes as a move, with marching ants until then, in one undo step', async ({
    page,
  }) => {
    const left = page.getByRole('grid', { name: 'Left grid' });
    await left.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('Control+x');
    expect(await state(page, 'left', 'm.clipboardMark')).toEqual({
      sheet: 's1',
      zone: { top: 0, left: 0, bottom: 0, right: 0 },
      cut: true,
    });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+v');
    await expect.poll(() => state(page, 'left', "m.value('s1', 2, 6)")).toBe('A1');
    expect(await state(page, 'left', "m.value('s1', 0, 0)")).toBeNull();
    expect(await state(page, 'left', 'm.clipboardMark')).toBeNull();
    await page.keyboard.press('Control+z');
    expect(await state(page, 'left', "m.value('s1', 0, 0)")).toBe('A1');
    expect(await state(page, 'left', "m.value('s1', 2, 6)")).toBeNull();
  });

  test('pastes values only with Ctrl+Shift+V', async ({ page }) => {
    await page.evaluate(() => {
      const m = (window as never as { cells: { left: { dispatch(c: unknown): unknown } } }).cells
        .left;
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 0, left: 0, bottom: 0, right: 0 },
        style: { bold: true },
      });
    });
    const left = page.getByRole('grid', { name: 'Left grid' });
    await left.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('Control+c');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+Shift+v');
    await expect.poll(() => state(page, 'left', "m.value('s1', 0, 6)")).toBe('A1');
    expect(await state(page, 'left', "m.style('s1', 0, 6)")).toEqual({});
  });

  test('refuses a paste past the end of the sheet, and says why', async ({ page }) => {
    await page.evaluate(() => navigator.clipboard.writeText('a\tb\tc'));
    const left = page.getByRole('grid', { name: 'Left grid' });
    await left.click({ position: { x: 118, y: 35 } });
    await page.evaluate(() => {
      const m = (window as never as { cells: { left: { select(s: unknown): void } } }).cells.left;
      m.select({
        sheet: 's1',
        zones: [{ top: 0, left: 16383, bottom: 0, right: 16383 }],
        anchor: { row: 0, col: 16383 },
        active: { row: 0, col: 16383 },
      });
    });
    await page.keyboard.press('Control+v');
    await expect(page.locator('[data-cells-live]').first()).toHaveText(
      /reaches past the end of the sheet/,
    );
  });
});
