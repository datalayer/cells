/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * C7-05: `CellsPlugin` in an actual Reactor shell (`@datalayer/reactor-shell`
 * on the examples' *A Reactor Shell* page): the shell's selector offers its
 * Spreadsheets view; the shell lists, opens, creates, renames and deletes
 * workbooks; and a function a plugin installed in the shell (Acme's TWICE)
 * works in every grid the shell opens.
 */
test('a Reactor shell lists, opens and creates workbooks, and a shell plugin adds a function to every grid', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/#/shell');
  const selector = page.getByRole('list', { name: 'Workspace' });
  await expect(selector.getByRole('button')).toHaveCount(2);
  await expect(selector.getByRole('button', { name: 'Home' })).toBeVisible();
  await expect(page.locator('[data-shell-view="none"]')).toBeVisible();
  await selector.getByRole('button', { name: 'Spreadsheets' }).click();

  // The list: Acme's workbook, contributed by its plugin; none open yet.
  const list = page.getByRole('navigation', { name: 'Workbooks' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('No workbook is open.')).toBeVisible();

  // Opened: its grid computes Acme's TWICE.
  await list.getByRole('button', { name: 'Acme prices', exact: true }).click();
  const prices = page.getByRole('grid', { name: 'Acme prices' });
  await expect(prices.getByRole('gridcell', { name: '9, formula: =TWICE(B3)' })).toHaveCount(1);
  await expect(page.getByRole('toolbar')).toBeVisible();
  await expect(page.getByRole('tablist')).toContainText('Prices');

  // New: an empty workbook, opened; TWICE works there too (the shell's platform).
  await list.getByRole('button', { name: 'New workbook' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const fresh = page.getByRole('grid').first();
  const name = await fresh.getAttribute('aria-label');
  expect(name).not.toBe('Acme prices');
  await fresh.focus();
  await page.keyboard.type('=TWICE(21)');
  await page.keyboard.press('Enter');
  await expect(fresh.getByRole('gridcell', { name: '42, formula: =TWICE(21)' })).toHaveCount(1);

  // Renamed, then deleted, from the list.
  await list.getByRole('button', { name: `Rename ${name}` }).click();
  const field = list.getByRole('textbox', { name: `Rename ${name}` });
  await field.fill('Scratch');
  await field.press('Enter');
  await expect(list.getByRole('button', { name: 'Scratch', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
  await list.getByRole('button', { name: 'Delete Scratch' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);

  // Back to the price list: still computed.
  await list.getByRole('button', { name: 'Acme prices', exact: true }).click();
  await expect(prices.getByRole('gridcell', { name: '6, formula: =TWICE(B2)' })).toHaveCount(1);
  expect(errors).toEqual([]);
});
