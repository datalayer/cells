/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { expect, type Page, test } from '@playwright/test';

/** The left grid of the test page holds A1..F12 with their own names. */
const left = (page: Page) => page.getByRole('grid', { name: 'Left grid' });

/** Read the left model, in the page. */
function state<T>(page: Page, read: string): Promise<T> {
  return page.evaluate(
    (code) =>
      new Function('m', `return ${code}`)(
        (window as never as { cells: { left: unknown } }).cells.left,
      ),
    read,
  ) as Promise<T>;
}
const value = (page: Page, row: number, col: number) =>
  state<unknown>(page, `m.value('s1', ${row}, ${col})`);

/** Do, undo and redo, checking the state after each. */
async function roundTrip(page: Page, check: () => Promise<void>, before: () => Promise<void>) {
  await check();
  await page.keyboard.press('Control+z');
  await before();
  await page.keyboard.press('Control+y');
  await check();
}

test.describe('structural editing (C3-02)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e.html');
    await left(page).click({ position: { x: 118, y: 35 } }); // A1
  });

  test('inserts rows from the context menu', async ({ page }) => {
    await page.keyboard.press('ArrowDown'); // A2
    await left(page).click({ button: 'right', position: { x: 118, y: 56 } });
    await page.getByRole('menuitem', { name: /Insert rows above/ }).click();
    await roundTrip(
      page,
      async () => {
        expect(await value(page, 1, 0)).toBeNull();
        expect(await value(page, 2, 0)).toBe('A2');
      },
      async () => expect(await value(page, 1, 0)).toBe('A2'),
    );
  });

  test('deletes rows by keyboard, and inserts columns when whole columns are selected', async ({
    page,
  }) => {
    await page.keyboard.press('Control+Alt+-');
    await roundTrip(
      page,
      async () => expect(await value(page, 0, 0)).toBe('A2'),
      async () => expect(await value(page, 0, 0)).toBe('A1'),
    );
    await page.keyboard.press('Control+Space'); // column A, whole
    await page.keyboard.press('Control+Alt+=');
    await roundTrip(
      page,
      async () => {
        expect(await value(page, 0, 0)).toBeNull();
        expect(await value(page, 0, 1)).toBe('A2');
      },
      async () => expect(await value(page, 0, 0)).toBe('A2'),
    );
  });

  test('moves rows and columns', async ({ page }) => {
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await roundTrip(
      page,
      async () => {
        expect(await value(page, 0, 0)).toBe('A2');
        expect(await value(page, 1, 0)).toBe('A1');
      },
      async () => expect(await value(page, 0, 0)).toBe('A1'),
    );
    expect(await state(page, 'm.selection.active.row')).toBe(1);
  });

  test('resizes a column by dragging its header edge, and fits it by double-clicking', async ({
    page,
  }) => {
    const grid = await left(page).boundingBox();
    // A million rows make the row header 68 px wide: column A's header spans x 68..168.
    const edgeX = grid!.x + 168;
    const y = grid!.y + 12;
    await page.mouse.move(edgeX, y);
    await page.mouse.down();
    await page.mouse.move(edgeX + 60, y, { steps: 4 });
    await page.mouse.up();
    await roundTrip(
      page,
      async () => expect(await state(page, "m.sheet('s1').cols.sizeOf(0)")).toBe(160),
      async () => expect(await state(page, "m.sheet('s1').cols.sizeOf(0)")).toBe(100),
    );
    await page.mouse.dblclick(grid!.x + 168 + 60, y);
    await expect.poll(() => state<number>(page, "m.sheet('s1').cols.sizeOf(0)")).toBeLessThan(60);
  });

  test('selects whole columns from their headers', async ({ page }) => {
    const grid = await left(page).boundingBox();
    await page.mouse.click(grid!.x + 218, grid!.y + 12); // column B
    await page.keyboard.down('Shift');
    await page.mouse.click(grid!.x + 318, grid!.y + 12); // to column C
    await page.keyboard.up('Shift');
    expect(await state(page, 'm.selection.zones[0]')).toEqual({
      top: 0,
      bottom: 1_048_575,
      left: 1,
      right: 2,
    });
  });

  test('hides and unhides rows', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Control+Alt+9');
    await roundTrip(
      page,
      async () => expect(await state(page, "m.sheet('s1').rows.isHidden(1)")).toBe(true),
      async () => expect(await state(page, "m.sheet('s1').rows.isHidden(1)")).toBe(false),
    );
    // Moves step over a hidden row, and the mirror leaves it out once the active cell has gone.
    await page.keyboard.press('ArrowDown');
    expect(await state(page, 'm.selection.active.row')).toBe(2);
    await expect(left(page).getByRole('gridcell', { name: 'A2', exact: true })).toHaveCount(0);
    await page.keyboard.press('ArrowUp');
    expect(await state(page, 'm.selection.active.row')).toBe(0);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+Shift+9');
    expect(await state(page, "m.sheet('s1').rows.isHidden(1)")).toBe(false);
  });

  test('merges and unmerges from the context menu', async ({ page }) => {
    await page.keyboard.press('Shift+ArrowRight');
    await left(page).click({ button: 'right', position: { x: 118, y: 35 } });
    await page.getByRole('menuitem', { name: 'Merge cells', exact: true }).click();
    await roundTrip(
      page,
      async () =>
        expect(await state(page, "m.sheet('s1').merges")).toEqual([
          { top: 0, left: 0, bottom: 0, right: 1 },
        ]),
      async () => expect(await state(page, "m.sheet('s1').merges")).toEqual([]),
    );
    await left(page).click({ button: 'right', position: { x: 118, y: 35 } });
    await page.getByRole('menuitem', { name: 'Unmerge cells', exact: true }).click();
    expect(await state(page, "m.sheet('s1').merges")).toEqual([]);
  });

  test('freezes panes from the menu, opened by keyboard', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Cell actions' })).toBeVisible();
    // Arrow keys reach the item; Enter runs it.
    const items = await page.getByRole('menuitem').allTextContents();
    const at = items.findIndex((t) => t.startsWith('Freeze up to the active cell'));
    for (let i = 0; i < at; i += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await roundTrip(
      page,
      async () => expect(await state(page, "m.sheet('s1').frozen")).toEqual({ rows: 1, cols: 1 }),
      async () => expect(await state(page, "m.sheet('s1').frozen")).toEqual({ rows: 0, cols: 0 }),
    );
  });

  test('a refused command is said, and changes nothing', async ({ page }) => {
    // Merging a single cell is refused.
    await left(page).click({ button: 'right', position: { x: 118, y: 35 } });
    await page.getByRole('menuitem', { name: 'Merge cells', exact: true }).click();
    await expect(page.locator('[data-cells-live]').first()).toHaveText(
      'A merge spans more than one cell.',
    );
    expect(await state(page, "m.sheet('s1').merges")).toEqual([]);
  });
});
