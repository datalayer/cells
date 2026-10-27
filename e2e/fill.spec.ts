/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { expect, type Page, test } from '@playwright/test';

function state<T>(page: Page, read: string): Promise<T> {
  return page.evaluate(
    (code) =>
      new Function('m', `return ${code}`)(
        (window as never as { cells: { right: unknown } }).cells.right,
      ),
    read,
  ) as Promise<T>;
}

test.describe('fill and sort (C3-05)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e.html');
    await page.evaluate(() => {
      const m = (
        window as never as {
          cells: { right: { dispatch(c: unknown): unknown; select(s: unknown): void } };
        }
      ).cells.right;
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 3, col: 0 }, cells: [[45000]] });
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 3, left: 0, bottom: 3, right: 0 },
        style: { format: 'yyyy-mm-dd' },
      });
    });
  });

  test('drags the fill handle down into a date series', async ({ page }) => {
    const grid = page.getByRole('grid', { name: 'Right grid' });
    await grid.click({ position: { x: 118, y: 98 } }); // A4
    const box = (await grid.boundingBox())!;
    // A4's bottom-right corner: x 68 + 100, y 24 + 4 rows of 21.
    const handle = { x: box.x + 168, y: box.y + 24 + 4 * 21 };
    await page.mouse.move(handle.x - 1, handle.y - 1);
    await page.mouse.down();
    await page.mouse.move(handle.x - 20, handle.y + 3 * 21 - 5, { steps: 5 });
    await expect(page.locator('[data-cells-fill-preview]')).toBeVisible();
    await page.mouse.up();
    await expect
      .poll(() => state(page, 'm.toRows({ top: 3, left: 0, bottom: 6, right: 0 }).flat()'))
      .toEqual([45000, 45001, 45002, 45003]);
    await expect(grid.getByRole('gridcell', { name: '2023-03-18', exact: true })).toHaveCount(1);
    await page.keyboard.press('Control+z');
    expect(await state(page, "m.value('s1', 4, 0)")).toBeNull();
  });

  test('fills down with Ctrl+D', async ({ page }) => {
    const grid = page.getByRole('grid', { name: 'Right grid' });
    await grid.click({ position: { x: 118, y: 98 } });
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+d');
    await expect
      .poll(() => state(page, 'm.toRows({ top: 3, left: 0, bottom: 5, right: 0 }).flat()'))
      .toEqual([45000, 45000, 45000]);
  });

  test('sorts from the context menu', async ({ page }) => {
    const grid = page.getByRole('grid', { name: 'Right grid' });
    // The right grid holds right 1 / grid 2 in A1:B2; sort its column A from Z to A.
    await grid.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    await grid.click({ button: 'right', position: { x: 118, y: 35 } });
    await page.getByRole('menuitem', { name: 'Sort Z to A' }).click();
    await expect
      .poll(() => state(page, 'm.toRows({ top: 0, left: 0, bottom: 1, right: 1 })'))
      .toEqual([
        ['right', 1],
        ['grid', 2],
      ]);
    await grid.click({ button: 'right', position: { x: 118, y: 35 } });
    await page.getByRole('menuitem', { name: 'Sort A to Z' }).click();
    await expect
      .poll(() => state(page, 'm.toRows({ top: 0, left: 0, bottom: 1, right: 1 })'))
      .toEqual([
        ['grid', 2],
        ['right', 1],
      ]);
  });
});
