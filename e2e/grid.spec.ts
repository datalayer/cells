/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/** The accessible name of the active cell: what a screen reader says on each move. */
async function activeName(grid: Locator): Promise<string> {
  const id = await grid.getAttribute('aria-activedescendant');
  return (await grid.page().locator(`[id="${id}"]`).textContent()) ?? '';
}

/** The colour of a canvas pixel, CSS px from the grid's top-left. */
async function pixel(
  page: Page,
  label: string,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  return page.evaluate(
    ({ label, x, y }) => {
      const grid = document.querySelector(`[role="grid"][aria-label="${label}"]`)!;
      const canvas = grid.querySelector('canvas')!;
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const d = canvas
        .getContext('2d')!
        .getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return [d[0], d[1], d[2]] as [number, number, number];
    },
    { label, x, y },
  );
}

test.describe('the grid', () => {
  test('two grids on one page move independently by keyboard', async ({ page }) => {
    await page.goto('/e2e.html');
    const left = page.getByRole('grid', { name: 'Left grid' });
    const right = page.getByRole('grid', { name: 'Right grid' });
    await left.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => activeName(left)).toBe('B2');
    await right.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => activeName(right)).toBe('grid');
    await expect.poll(() => activeName(left)).toBe('B2');
  });

  test('a remount keeps the model, under Strict Mode', async ({ page }) => {
    await page.goto('/e2e.html');
    const left = page.getByRole('grid', { name: 'Left grid' });
    await left.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('ArrowDown');
    await page.getByRole('button', { name: 'Unmount the left grid' }).click();
    await expect(left).toHaveCount(0);
    await page.getByRole('button', { name: 'Mount the left grid' }).click();
    await expect.poll(() => activeName(page.getByRole('grid', { name: 'Left grid' }))).toBe('A2');
  });

  test('a keyboard-only script reads A1 to D10 through the accessibility tree', async ({
    page,
  }) => {
    await page.goto('/e2e.html');
    const grid = page.getByRole('grid', { name: 'Left grid' });
    await grid.focus();
    const read: string[] = [];
    for (let r = 0; r < 10; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        read.push(await activeName(grid));
        if (c < 3) await page.keyboard.press('ArrowRight');
      }
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
    }
    const expected = Array.from({ length: 10 }, (_, r) =>
      ['A', 'B', 'C', 'D'].map((c) => `${c}${r + 1}`),
    ).flat();
    expect(read).toEqual(expected);
    const tree = await grid.ariaSnapshot();
    expect(tree).toContain('gridcell "D10"');
    expect(tree).toContain('columnheader "D"');
  });

  test('axe finds no violation on the test page and on every example', async ({ page }) => {
    for (const url of [
      '/e2e.html',
      '/#/minimal',
      '/#/formulas',
      '/#/editing',
      '/#/theming',
      '/#/react-api',
      '/#/plugin',
      '/#/collaboration',
      '/#/import-export',
      '/#/chrome',
    ]) {
      await page.goto(url);
      await page.locator('[role="grid"]').first().waitFor();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations.map((v) => `${url}: ${v.id} ${v.help}`)).toEqual([]);
    }
  });

  test('Ctrl+End reaches the millionth row in one step', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/#/large');
    await page.getByRole('button', { name: /Load 11 columns/ }).click();
    const grid = page.getByRole('grid', { name: 'A million rows' });
    await grid.waitFor({ timeout: 150_000 });
    await grid.click({ position: { x: 118, y: 35 } });
    await page.keyboard.press('Control+End');
    await expect.poll(() => activeName(grid)).toBe('Row 1000000 of a million');
    await page.keyboard.press('Control+Home');
    await expect.poll(() => activeName(grid)).toBe('0');
  });

  test("theme auto reads the page's Primer variables, and a variant loads from primer-addons", async ({
    page,
  }) => {
    await page.goto('/#/theming');
    await page.getByRole('grid', { name: 'Page grid' }).waitFor();
    // An empty cell's background, light: the page sets --bgColor-default to #fffdf5.
    await expect.poll(() => pixel(page, 'Page grid', 300, 150)).toEqual([0xff, 0xfd, 0xf5]);
    // primer-addons' appearance chooser: the colour mode, then a theme.
    // The page's chooser, in main: the site's appearance menu in the title row has its own.
    await page.getByRole('main').getByRole('button', { name: 'Dark' }).click();
    await expect.poll(() => pixel(page, 'Page grid', 300, 150)).toEqual([0x0d, 0x11, 0x17]);
    const before = (await pixel(page, 'Themed grid', 300, 150)).join(',');
    await page.getByRole('main').getByRole('button', { name: 'Loop', exact: true }).click();
    await expect
      .poll(async () => (await pixel(page, 'Themed grid', 300, 150)).join(','))
      .not.toBe(before);
  });

  test('under forced colours the grid draws in system colours', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/#/minimal');
    await page.getByRole('grid').waitFor();
    const [r, g, b] = await pixel(page, 'Fruit', 300, 150);
    // Canvas, the system background: white or black, never a tinted Primer surface.
    expect(r === g && g === b).toBe(true);
  });
});
