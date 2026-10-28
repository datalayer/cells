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
  ['cell-types', 'Cell types'],
  ['data-sources', 'Data sources'],
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
    await page.getByRole('button', { name: 'UPPERCASE the selection', exact: true }).last().click();
    await expect(page.getByRole('gridcell', { name: 'HELLO', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Disable it' }).click();
    await page.getByRole('button', { name: 'UPPERCASE the selection', exact: true }).last().click();
    await expect(page.getByText(/No plugin handles the command 'UPPERCASE'/)).toBeVisible();
  });

  test('every point is listed with what the plugin contributes, the gate refuses, a duplicate is refused at start', async ({
    page,
  }) => {
    await page.goto('/#/plugin');
    const table = page.getByRole('table', { name: 'Contribution points' });
    await expect(table.locator('tbody tr')).toHaveCount(17);
    await expect(table.locator('tbody td:nth-child(2)')).not.toContainText(['none']);
    await page.getByRole('button', { name: 'Write into row 1' }).click();
    await expect(page.locator('[data-message]')).toHaveText(
      "Row 1 is Acme's header row: locked by @acme/everything.",
    );
    await page.getByRole('button', { name: 'Start a grid with a duplicate plugin' }).click();
    await expect(page.locator('[data-duplicate]')).toContainText(
      "The function 'SHOUT' is contributed twice to datalayer.cells.function: by @acme/everything (id 'SHOUT') and by @acme/twice (id 'SHOUT').",
    );
    // The toolbar holds the plugin's two commands and nothing else; the data source's primes arrived.
    const toolbar = page.getByRole('toolbar');
    await expect(toolbar.getByRole('button')).toHaveCount(2);
    await expect(page.getByRole('gridcell', { name: '8161', exact: true })).toHaveCount(0);
    await expect(page.getByRole('gridcell', { name: '2', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Shouted: LOUD' })).toHaveCount(1);
  });

  test('a checkbox cell toggles with Space and a click, a link cell is named as one', async ({
    page,
  }) => {
    await page.goto('/#/cell-types');
    const grid = page.getByRole('grid', { name: 'Tasks' });
    await expect(grid.getByRole('gridcell', { name: 'checked', exact: true })).toHaveCount(2);
    await expect(grid.getByRole('gridcell', { name: 'https://datalayer.io, link' })).toHaveCount(1);
    await expect(grid.getByRole('gridcell', { name: '80 percent' })).toHaveCount(1);
    // A2 (not checked) is the active cell: Space checks it, and the COUNTIF above follows.
    await grid.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(' ');
    await expect(grid.getByRole('gridcell', { name: 'checked', exact: true })).toHaveCount(3);
    await expect(page.getByText('3 of 6 tasks done')).toBeVisible();
    await page.keyboard.press(' ');
    await expect(grid.getByRole('gridcell', { name: 'checked', exact: true })).toHaveCount(2);
  });

  test('a data source shows #BUSY! then its rows, its SUM settles, and a failed page is said', async ({
    page,
  }) => {
    await page.goto('/#/data-sources');
    const grid = page.getByRole('grid', { name: 'Orders' });
    await expect(grid.getByRole('gridcell', { name: 'Widget', exact: true }).first()).toBeVisible();
    await expect(page.getByText(/2 resident of 64/)).toBeVisible();
    // The SUM over two pages settled into a number.
    const status = page.locator('[data-source-status]').locator('..');
    await expect(status.locator('strong').first()).not.toHaveText(/BUSY|N\/A|^0$/);
    await expect(status.locator('strong').nth(1)).toHaveText('2048');
    // Scrolled to the far end, a page of the last rows arrives on demand.
    await page
      .locator('[data-cells-scroller]')
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(grid.getByRole('gridcell', { name: '10000000', exact: true })).toHaveCount(1);
    // The bound cells refuse edits: Ctrl+End lands on the last cell with content (H, the COUNTA's
    // column, on the last row read); three columns left is E, the last bound column.
    await grid.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('x');
    await page.keyboard.press('Enter');
    await expect(grid.locator('[data-cells-editor]')).toHaveAttribute('aria-describedby', /.+/);
    await expect(
      grid.getByText(/shows the data source 'orders' and cannot be changed/),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fail the next page' }).click();
    await expect(page.getByRole('list', { name: 'Data source errors' })).toContainText(
      'did not answer',
    );
    await expect(grid.getByRole('gridcell', { name: /#N\/A/ }).first()).toBeVisible();
  });

  test('an asynchronous plugin function resolves into the grid; a built-in function is #NAME? on the bare grid', async ({
    page,
  }) => {
    await page.goto('/#/plugin');
    const grid = page.getByRole('grid', { name: 'Plugin' });
    await expect(
      grid.getByRole('gridcell', { name: 'quiet…quiet, formula: =ECHO(A3)' }),
    ).toHaveCount(1);
    await expect(
      grid.getByRole('gridcell', { name: /#NAME\?, formula: =SUM\(B2:B3\)/ }),
    ).toHaveCount(1);
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
    await page.getByLabel(/^Write into A1$/).fill('shared');
    await page.getByLabel(/^Write into A1$/).press('Enter');
    for (const name of ['Left pane', 'Right pane']) {
      await expect(
        page.getByRole('grid', { name }).getByRole('gridcell', { name: 'shared', exact: true }),
      ).toHaveCount(1);
    }
  });
});
