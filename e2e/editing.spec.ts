/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { expect, type Locator, type Page, test } from '@playwright/test';

async function activeName(grid: Locator): Promise<string> {
  const id = await grid.getAttribute('aria-activedescendant');
  return (await grid.page().locator(`[id="${id}"]`).textContent()) ?? '';
}

/** The text a cell shows, by its accessible name in the mirror. */
const cell = (page: Page, name: string) =>
  page.getByRole('grid', { name: 'Editing' }).getByRole('gridcell', { name, exact: true });

test.describe('editing (C3-01)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/editing');
    await page.getByRole('grid', { name: 'Editing' }).click({ position: { x: 118, y: 35 } });
  });

  test('typing replaces a cell, Enter commits and moves down, Tab moves right', async ({
    page,
  }) => {
    await page.keyboard.type('hello');
    await expect(page.getByRole('textbox', { name: 'Edit A1, Sheet1' })).toHaveValue('hello');
    await page.keyboard.press('Enter');
    await expect(cell(page, 'hello')).toHaveCount(1);
    await expect
      .poll(() => page.getByRole('grid', { name: 'Editing' }).getAttribute('aria-activedescendant'))
      .toContain('-r1-c0');
    await page.keyboard.type('42');
    await page.keyboard.press('Tab');
    await expect(cell(page, '42')).toHaveCount(1);
    await expect
      .poll(() => page.getByRole('grid', { name: 'Editing' }).getAttribute('aria-activedescendant'))
      .toContain('-r1-c1');
  });

  test('a formula is kept and evaluated, and Shift+Enter goes back up', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('=A1*2');
    await page.keyboard.press('Shift+Enter');
    await expect(cell(page, '0, formula: =A1*2')).toHaveCount(1);
    await expect
      .poll(() => page.getByRole('grid', { name: 'Editing' }).getAttribute('aria-activedescendant'))
      .toContain('-r0-c0');
    await page.keyboard.type('=NOPE()');
    await page.keyboard.press('Enter');
    await expect(cell(page, '#NAME?, formula: =NOPE(), unknown name')).toHaveCount(1);
  });

  test('double-clicking a cell edits it, caret at the end; Enter commits', async ({ page }) => {
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    const grid = page.getByRole('grid', { name: 'Editing' });
    await grid.dblclick({ position: { x: 118, y: 35 } }); // A1
    const editor = page.getByRole('textbox', { name: 'Edit A1, Sheet1' });
    await expect(editor).toHaveValue('abc');
    await expect(editor).toBeFocused();
    expect(
      await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([3, 3]);
    await page.keyboard.type('d');
    await page.keyboard.press('Enter');
    await expect(editor).toHaveCount(0);
    await expect(cell(page, 'abcd')).toHaveCount(1);
    await expect.poll(() => grid.getAttribute('aria-activedescendant')).toContain('-r1-c0');
  });

  test('a formula by autocomplete, the mouse and F4', async ({ page }) => {
    for (const v of ['1', '2', '3']) {
      await page.keyboard.type(v);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type('=su');
    const list = page.getByRole('listbox', { name: 'Functions' });
    await expect(list.getByRole('option').first()).toContainText('SUBSTITUTE');
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option', { selected: true })).toContainText('SUM');
    await page.keyboard.press('Tab');
    const editor = page.getByRole('combobox', { name: 'Edit A4, Sheet1' });
    await expect(editor).toHaveValue('=SUM(');
    await expect(list).toHaveCount(0);
    const grid = page.getByRole('grid', { name: 'Editing' });
    await grid.click({ position: { x: 118, y: 35 } }); // A1
    await grid.click({ position: { x: 118, y: 77 }, modifiers: ['Shift'] }); // A3
    await expect(editor).toHaveValue('=SUM(A1:A3');
    await expect(editor).toBeFocused();
    await page.keyboard.press('F4');
    await expect(editor).toHaveValue('=SUM($A$1:$A$3');
    await page.keyboard.type(')');
    await page.keyboard.press('Enter');
    await expect(cell(page, '6, formula: =SUM($A$1:$A$3)')).toHaveCount(1);
  });

  test('F2 edits what is there, Escape leaves the cell as it was', async ({ page }) => {
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('F2');
    const editor = page.getByRole('textbox', { name: 'Edit A1, Sheet1' });
    await expect(editor).toHaveValue('abc');
    await page.keyboard.type('def');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(cell(page, 'abc')).toHaveCount(1);
    await page.keyboard.press('F2');
    await page.keyboard.type('!');
    await page.keyboard.press('Enter');
    await expect(cell(page, 'abc!')).toHaveCount(1);
  });

  test('Alt+Enter is a new line, Delete clears, Ctrl+Z undoes', async ({ page }) => {
    await page.keyboard.type('one');
    await page.keyboard.press('Alt+Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await expect(cell(page, 'one\ntwo')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Delete');
    await expect(cell(page, 'one\ntwo')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(cell(page, 'one\ntwo')).toHaveCount(1);
  });

  test('keys during an input method composition belong to it', async ({ page }) => {
    await page.keyboard.type('x');
    const editor = page.getByRole('textbox', { name: 'Edit A1, Sheet1' });
    await editor.evaluate((el: HTMLTextAreaElement) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    });
    // An Enter the input method takes (isComposing) leaves the editor open.
    await editor.evaluate((el: HTMLTextAreaElement) => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(editor).toHaveCount(1);
    await editor.evaluate((el: HTMLTextAreaElement) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    });
    await page.keyboard.insertText('日本');
    await page.keyboard.press('Enter');
    await expect(cell(page, 'x日本')).toHaveCount(1);
  });

  test('the formula bar and the in-cell editor share one buffer', async ({ page }) => {
    await page.keyboard.type('shared');
    await expect(page.getByLabel('Formula bar')).toHaveValue('shared');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.getByLabel('Formula bar').fill('from the bar');
    await page.getByLabel('Formula bar').press('Enter');
    await expect(cell(page, 'from the bar')).toHaveCount(1);
  });

  test('the active cell is read by its name', async ({ page }) => {
    await page.keyboard.type('named');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => activeName(page.getByRole('grid', { name: 'Editing' }))).toBe('named');
  });
});
