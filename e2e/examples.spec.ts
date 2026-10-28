/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { expect, test } from '@playwright/test';

const EXAMPLES = [
  ['minimal', 'A few values'],
  ['formulas', 'Formulas and recalculation'],
  ['editing', 'Editing, clipboard, fill and sort'],
  ['large', 'A million rows'],
  ['theming', 'Theming (Primer light and dark)'],
  ['import-export', 'Import and export'],
  ['react-api', 'The React API'],
  ['plugin', 'A Reactor plugin'],
  ['collaboration', 'Collaboration'],
  ['chrome', 'Toolbar, formula bar and sheet tabs'],
  ['charts', 'Charts'],
] as const;

test.describe('the examples', () => {
  for (const [id, title] of EXAMPLES) {
    test(`${id} opens with no console error`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`/#/${id}`);
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(title);
      await expect(page.locator('nav a[aria-current="page"]')).toHaveText(title);
      expect(errors).toEqual([]);
    });
  }

  test('the menu runs from simple to advanced', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('nav li')).toHaveText(EXAMPLES.map(([, t]) => t));
  });

  test('the plugin command works, and is refused once the plugin is disabled', async ({ page }) => {
    await page.goto('/#/plugin');
    await page.getByRole('button', { name: 'UPPERCASE the selection' }).click();
    await expect(page.getByRole('gridcell', { name: 'HELLO', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Disable it' }).click();
    await page.getByRole('button', { name: 'UPPERCASE the selection' }).click();
    await expect(page.getByText(/No plugin handles the command 'UPPERCASE'/)).toBeVisible();
  });

  test('an asynchronous plugin function resolves into the grid, its dependent follows', async ({
    page,
  }) => {
    await page.goto('/#/plugin');
    const grid = page.getByRole('grid', { name: 'Plugin' });
    await expect(
      grid.getByRole('gridcell', { name: 'hello…hello, formula: =ECHO(A1)' }),
    ).toHaveCount(1);
    await expect(grid.getByRole('gridcell', { name: '11, formula: =LEN(A4)' })).toHaveCount(1);
  });

  test('a CSV file opens through the worker, and the sheet exports as CSV', async ({ page }) => {
    await page.goto('/#/import-export');
    await page.getByLabel('Open a CSV or TSV file').setInputFiles({
      name: 'people.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('\ufeffname;born;share\r\n"Lovelace; Ada";2023-03-15;50%\r\n'),
    });
    await expect(page.getByRole('status')).toContainText(
      'people.csv: 2 rows of 3, separated by ";"',
    );
    const grid = page.getByRole('grid', { name: 'Imported' });
    await expect(grid.getByRole('gridcell', { name: 'Lovelace; Ada', exact: true })).toHaveCount(1);
    await expect(grid.getByRole('gridcell', { name: '2023-03-15', exact: true })).toHaveCount(1);
    await expect(grid.getByRole('gridcell', { name: '50%', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Export the sheet as CSV' }).click();
    // A textarea shows CRLF line ends as LF.
    await expect(page.getByRole('textbox', { name: 'CSV' })).toHaveValue(
      'name,born,share\nLovelace; Ada,45000,0.5\n',
    );
  });

  test('two grids on one model show the same cells', async ({ page }) => {
    await page.goto('/#/collaboration');
    await page.getByLabel(/Write into A1/).fill('shared');
    await page.getByLabel(/Write into A1/).press('Enter');
    for (const name of ['Left pane', 'Right pane']) {
      await expect(
        page.getByRole('grid', { name }).getByRole('gridcell', { name: 'shared', exact: true }),
      ).toHaveCount(1);
    }
  });
});
