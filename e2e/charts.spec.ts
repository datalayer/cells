/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/** A holder's place and size, in CSS px, from its own style (the layer sets them). */
async function place(holder: Locator) {
  return holder.evaluate((el) => {
    const s = (el as HTMLElement).style;
    return {
      x: parseFloat(s.left),
      y: parseFloat(s.top),
      width: parseFloat(s.width),
      height: parseFloat(s.height),
    };
  });
}

/** A grid and its spreadsheet: the charts sit beside the grid (a grid owns rows only), in its spreadsheet. */
function spreadsheet(page: Page, name: string) {
  const grid = page.getByRole('grid', { name });
  return { grid, area: page.locator('[data-cells]').filter({ has: grid }) };
}

async function openCharts(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto('/#/charts');
  const { grid, area } = spreadsheet(page, 'Figures with charts');
  // ECharts loads lazily with the charts plugin: wait for the first drawing.
  await expect(area.getByRole('figure')).toHaveCount(4);
  await expect(area.locator('[data-cells-chart] canvas').first()).toBeVisible();
  return { grid, area };
}

test.describe('charts (C10-04)', () => {
  test('insert from a selection, move and resize by keyboard and mouse, the panel, delete, each with undo and redo, and a copy to a second grid', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const { grid, area } = await openCharts(page);
    const figures = area.getByRole('figure');
    const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' });
    const redo = page.getByRole('button', { name: 'Redo (Ctrl+Y)' });

    // Insert: A1:C5 selected with the keyboard, then the toolbar's type picker.
    await grid.focus();
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowDown');
    for (let i = 0; i < 2; i += 1) await page.keyboard.press('Shift+ArrowRight');
    await page.getByRole('button', { name: 'Insert chart' }).click();
    await page.getByRole('menuitem', { name: 'Column' }).click();
    await expect(figures).toHaveCount(5);
    const inserted = area.locator('[data-cells-chart][aria-current="true"]');
    await expect(inserted).toHaveAttribute('data-cells-chart-type', 'column');
    await expect(inserted).toHaveAccessibleName('Column chart of 2 series');
    await undo.click();
    await expect(figures).toHaveCount(4);
    await redo.click();
    await expect(figures).toHaveCount(5);
    const id = await area.locator('[data-cells-chart]').last().getAttribute('data-cells-chart');
    const chart = area.locator(`[data-cells-chart="${id}"]`);
    const holder = area.locator(`[data-cells-chart-holder]:has([data-cells-chart="${id}"])`);
    const start = await place(holder);

    // Copy: E1, the cell under the chart's top-left corner (beside A1:C5), travels to the second
    // grid with the chart, whose sheet of the same name holds next year's figures.
    await grid.focus();
    await page.keyboard.press('Control+Home');
    await expect(area.locator('[data-cells-chart][aria-current="true"]')).toHaveCount(0);
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+c');
    const { grid: second, area: secondArea } = spreadsheet(page, 'Next year');
    await second.scrollIntoViewIfNeeded();
    await second.click({ position: { x: 400, y: 300 } });
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Control+v');
    const pasted = secondArea.getByRole('figure');
    await expect(pasted).toHaveCount(1);
    await expect(pasted).toHaveAccessibleName('Column chart of 2 series');
    // Next year's North, Jan to Apr: 15, 18, 17, 21 (this year's: 12, 15, 14, 18).
    await expect(pasted).toHaveAccessibleDescription(/North runs from 15 to 21/);
    await expect(chart).toHaveAccessibleDescription(/North runs from 12 to 18/);
    await expect(figures).toHaveCount(5);
    await page.mouse.wheel(0, -2000);

    // The keyboard: a click on the frame selects it; an arrow moves it one cell, Shift+arrow resizes it.
    await chart.click({ position: { x: 20, y: 20 } });
    await expect(chart).toHaveAttribute('aria-current', 'true');
    await expect(chart).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => place(holder).then((p) => p.x)).toBeGreaterThan(start.x);
    const movedRight = await place(holder);
    // The anchor keeps its span of cells: the width follows the columns it now covers.
    expect(movedRight.y).toBe(start.y);
    await undo.click();
    await expect.poll(() => place(holder)).toEqual(start);
    await redo.click();
    await expect.poll(() => place(holder)).toEqual(movedRight);
    await chart.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(() => place(holder).then((p) => p.height)).toBeGreaterThan(start.height);
    const taller = await place(holder);
    expect([taller.x, taller.y]).toEqual([movedRight.x, movedRight.y]);
    await undo.click();
    await expect.poll(() => place(holder)).toEqual(movedRight);
    await redo.click();
    await expect.poll(() => place(holder)).toEqual(taller);

    // The mouse: drag the frame down and left by whole cells, then the south-east handle.
    const box = (await holder.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x - 130, box.y + 70, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => place(holder).then((p) => p.x)).toBeLessThan(taller.x);
    const dragged = await place(holder);
    expect(dragged.y).toBeGreaterThan(taller.y);
    await undo.click();
    await expect.poll(() => place(holder)).toEqual(taller);
    await redo.click();
    await expect.poll(() => place(holder)).toEqual(dragged);
    await chart.click({ position: { x: 20, y: 20 } });
    const se = (await holder.locator('[data-cells-chart-handle="se"]').boundingBox())!;
    await page.mouse.move(se.x + 4, se.y + 4);
    await page.mouse.down();
    await page.mouse.move(se.x + 150, se.y + 60, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => place(holder).then((p) => p.width)).toBeGreaterThan(dragged.width);
    const resized = await place(holder);
    expect(resized.height).toBeGreaterThan(dragged.height);
    expect([resized.x, resized.y]).toEqual([dragged.x, dragged.y]);
    await undo.click();
    await expect.poll(() => place(holder)).toEqual(dragged);
    await redo.click();
    await expect.poll(() => place(holder)).toEqual(resized);

    // The panel: the type, then the title, each one step.
    await chart.click({ position: { x: 20, y: 20 } });
    const panel = page.locator('[data-cells-chart-panel]');
    await panel.getByLabel('Type', { exact: true }).selectOption('line');
    await expect(chart).toHaveAttribute('data-cells-chart-type', 'line');
    await undo.click();
    await expect(chart).toHaveAttribute('data-cells-chart-type', 'column');
    await redo.click();
    await expect(chart).toHaveAttribute('data-cells-chart-type', 'line');
    await chart.click({ position: { x: 20, y: 20 } });
    await panel.getByLabel('Title', { exact: true }).fill('North and South, spring');
    await panel.getByLabel('Title', { exact: true }).press('Enter');
    await expect(chart).toHaveAccessibleName('North and South, spring');
    await undo.click();
    await expect(chart).toHaveAccessibleName('Line chart of 2 series');
    await redo.click();
    await expect(chart).toHaveAccessibleName('North and South, spring');

    // Delete: Delete on the selected frame, undone and redone.
    await chart.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Delete');
    await expect(figures).toHaveCount(4);
    await expect(chart).toHaveCount(0);
    await undo.click();
    await expect(figures).toHaveCount(5);
    await expect(chart).toHaveAccessibleName('North and South, spring');
    await redo.click();
    await expect(figures).toHaveCount(4);
    expect(errors).toEqual([]);
  });
});

/** Run a context-menu item from the keyboard: Shift+F10, then the arrows to the item, then Enter. */
async function menuItem(page: Page, name: string) {
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Cell actions' });
  await expect(menu).toBeVisible();
  const item = menu.getByRole('menuitem', { name: new RegExp(`^${name}`) });
  await expect(item).toHaveCount(1);
  for (let i = 0; i < 40; i += 1) {
    if (
      await item.evaluate(
        (el) => el === document.activeElement || el.contains(document.activeElement),
      )
    )
      break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(item).toBeFocused();
  await page.keyboard.press('Enter');
}

test.describe('accessible charts (C10-05)', () => {
  test('axe finds no violation on the charts example, with and without a chart selected, light and dark', async ({
    page,
  }) => {
    const { grid, area } = await openCharts(page);
    const check = async (when: string) => {
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.flatMap((v) =>
          v.nodes.map((n) => `${when}: ${v.id} ${n.target.join(' ')}: ${n.failureSummary}`),
        ),
      ).toEqual([]);
    };
    await check('light');
    await area.locator('[data-cells-chart="column"]').click({ position: { x: 20, y: 20 } });
    await expect(
      page.locator('[data-cells-chart-panel]').getByLabel('Title', { exact: true }),
    ).toHaveValue('Units sold, by region');
    await check('light, a chart selected');
    await page.getByRole('main').getByRole('button', { name: 'Dark' }).click();
    await expect(area.locator('[data-cells-chart] canvas').first()).toBeVisible();
    // The page's text has turned light and its colour transitions are over before axe reads it.
    await page.waitForFunction(() => {
      const rgb = getComputedStyle(document.querySelector('main p')!).color.match(/\d+/g)!;
      return (
        Number(rgb[0]) > 150 && document.getAnimations().every((a) => a.playState !== 'running')
      );
    });
    await check('dark');
  });

  test('the keyboard alone reaches a chart, moves it, shows its data and returns to the grid', async ({
    page,
  }) => {
    const { grid, area } = await openCharts(page);
    // Tab from the page's first control to the grid, as a keyboard user does.
    await page.getByRole('main').getByRole('button', { name: 'Light' }).focus();
    for (let i = 0; i < 40; i += 1) {
      if (await grid.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(grid).toBeFocused();

    // Go to chart, from the context menu: the first chart's frame takes the focus, named.
    await menuItem(page, 'Go to chart');
    const chart = page.getByRole('figure', { name: 'Units sold, by region' });
    await expect(chart).toBeFocused();
    await expect(chart).toHaveAttribute('aria-current', 'true');
    await expect(chart).toHaveAccessibleDescription(/3 series, 12 categories from Jan to Dec/);
    const holder = area.locator('[data-cells-chart-holder]:has([data-cells-chart="column"])');
    const start = await place(holder);
    // Moved down a row and back, said in the live region.
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => place(holder).then((p) => p.y)).toBeGreaterThan(start.y);
    await expect(area.locator('[data-cells-live]')).toHaveText('Moved the chart');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => place(holder)).toEqual(start);
    // Escape returns to the grid; Go to chart again reaches the same first chart.
    await page.keyboard.press('Escape');
    await expect(grid).toBeFocused();
    await expect(area.locator('[data-cells-chart][aria-current="true"]')).toHaveCount(0);
    await menuItem(page, 'Go to chart');
    await expect(chart).toBeFocused();

    // Show chart data (Shift+Enter): the grid selects the chart's source, B1:D13 and A2:A13.
    await page.keyboard.press('Shift+Enter');
    await expect(grid.getByRole('gridcell', { name: 'North', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(grid.getByRole('gridcell', { name: 'Dec', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(area.locator('[data-cells-chart][aria-current="true"]')).toHaveCount(0);
    // Back in the grid, the arrows move the active cell again, not a chart.
    await page.keyboard.press('Escape');
    await grid.focus();
    await expect(grid).toBeFocused();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowRight');
    await expect(grid.getByRole('gridcell', { name: 'North', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await place(holder)).toEqual(start);

    // The context menu on the chart itself (Shift+F10 on its frame): Show chart data acts on it.
    await menuItem(page, 'Go to chart');
    await expect(chart).toBeFocused();
    await menuItem(page, 'Show chart data');
    await expect(grid.getByRole('gridcell', { name: 'Online', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(area.locator('[data-cells-chart][aria-current="true"]')).toHaveCount(0);
  });
});
