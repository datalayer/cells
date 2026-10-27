/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { expect, test } from '@playwright/test';

/**
 * C3-06: a budget sheet built without a pointer. Values, styles and number
 * formats; then (C4-05) its total, pointed at with the arrow keys.
 */
test('builds a budget sheet with the keyboard only', async ({ page }) => {
  await page.goto('/e2e.html');
  // Start at the page's first control, then reach the grid with Tab, as a keyboard user does.
  await page.getByRole('button').first().focus();

  // Each grid is one tab stop; Escape, then Tab, leaves one.
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('Tab');
    const [role, label] = await page.evaluate(() => [
      document.activeElement?.getAttribute('role'),
      document.activeElement?.getAttribute('aria-label'),
    ]);
    if (label === 'Budget') break;
    if (role === 'grid') await page.keyboard.press('Escape');
  }
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
    'Budget',
  );

  // The header row, typed with Tab between cells and Enter at its end.
  await page.keyboard.type('Item');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Amount');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Share');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  const rows: [string, string, string][] = [
    ['Rent', '1200', '0.6'],
    ['Food', '450.5', '0.225'],
    ['Transport', '349.5', '0.175'],
  ];
  for (const row of rows) {
    for (let c = 0; c < row.length; c += 1) {
      await page.keyboard.type(row[c]);
      await page.keyboard.press(c < row.length - 1 ? 'Tab' : 'Enter');
    }
    await page.keyboard.press('Home');
  }

  // Bold header: Ctrl+Home, select the row's three cells, Ctrl+B.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+b');
  // Amounts as currency, shares as percent.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+Shift+$');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+Shift+%');

  const grid = page.getByRole('grid', { name: 'Budget' });
  for (const name of [
    'Item',
    'Amount',
    'Share',
    'Rent',
    '$1,200.00',
    '60%',
    'Food',
    '$450.50',
    '23%',
    'Transport',
    '$349.50',
    '18%',
  ]) {
    await expect(grid.getByRole('gridcell', { name, exact: true })).toHaveCount(1);
  }
  const model = await page.evaluate(() => {
    const m = (
      window as never as {
        cells: { budget: { toJSON(): unknown; style(s: string, r: number, c: number): unknown } };
      }
    ).cells.budget;
    return { header: m.style('s1', 0, 1), amount: m.style('s1', 2, 1) };
  });
  expect(model.header).toEqual({ bold: true });
  expect(model.amount).toEqual({ format: '$#,##0.00;($#,##0.00)' });

  // C4-05: the totals, by pointing only. Under the amounts, =SUM( then the arrows.
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('=SUM(');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  const editor = page.getByRole('combobox', { name: 'Edit B5, Sheet1' });
  await expect(editor).toHaveValue('=SUM(B2:B4');
  await expect(page.locator('[data-cells-reference="B2:B4"]')).toHaveCount(1);
  await expect(page.getByRole('tooltip')).toContainText('SUM(number1');
  await page.keyboard.type(')');
  await page.keyboard.press('Enter');
  const total = await page.evaluate(() => {
    const m = (
      window as never as {
        cells: {
          budget: {
            content(s: string, r: number, c: number): { formula?: string } | null;
            value(s: string, r: number, c: number): unknown;
          };
        };
      }
    ).cells.budget;
    return { formula: m.content('s1', 4, 1)?.formula, value: m.value('s1', 4, 1) };
  });
  expect(total).toEqual({ formula: 'SUM(B2:B4)', value: 2000 });
});
