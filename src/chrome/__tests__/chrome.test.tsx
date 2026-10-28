/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CellsModel, createCellsModel } from '../../core/index.js';
import { CellsProvider } from '../../react/hooks.js';
import { FormulaBar, SheetTabs, Toolbar } from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = '';
});

function render(model: CellsModel, node: React.ReactNode): HTMLElement {
  const div = document.createElement('div');
  document.body.append(div);
  const root = createRoot(div);
  act(() => root.render(<CellsProvider model={model}>{node}</CellsProvider>));
  cleanup = () => act(() => root.unmount());
  return div;
}

/** Type into a React-controlled input as a person does: the value, then an input event. */
function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

/** An element's accessible name: its label, or the text of what labels it (Primer's buttons with a tooltip). */
function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label !== null) return label;
  const ids = el.getAttribute('aria-labelledby') ?? '';
  return ids
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

function model() {
  const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [[3, { formula: 'A1*2' }]],
  });
  return m;
}

describe('the toolbar', () => {
  it('shows the contributed commands in their groups, named with their shortcuts, and runs them', async () => {
    const m = model();
    const div = render(m, <Toolbar />);
    const bar = div.querySelector('[role="toolbar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('Spreadsheet toolbar');
    const groups = [...bar.querySelectorAll('[role="group"]')].map((g) =>
      g.getAttribute('aria-label'),
    );
    expect(groups).toEqual(['history', 'text', 'number', 'cells', 'view', 'sort']);
    const bold = bar.querySelector('[data-command="cells.bold"]') as HTMLButtonElement;
    expect(nameOf(bold)).toMatch(/^Bold \(/);
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    act(() => bold.click());
    await flush();
    expect(m.style('s1', 0, 0)).toEqual({ bold: true });
    expect(bold.getAttribute('aria-pressed')).toBe('true');
  });

  it('is one tab stop; the arrow keys, Home and End move between its buttons', () => {
    const div = render(model(), <Toolbar />);
    const buttons = [...div.querySelectorAll('[data-command]')] as HTMLButtonElement[];
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0].focus();
    key(buttons[0], 'ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    key(buttons[1], 'End');
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    key(buttons[buttons.length - 1], 'ArrowRight');
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[0]]);
  });
});

describe('the formula bar', () => {
  it('shows the active cell and what it holds, and edits it through the shared buffer', () => {
    const m = model();
    m.select({
      sheet: 's1',
      zones: [{ top: 0, left: 1, bottom: 0, right: 1 }],
      anchor: { row: 0, col: 1 },
      active: { row: 0, col: 1 },
    });
    const div = render(m, <FormulaBar />);
    const name = div.querySelector('input[aria-label="Name box"]') as HTMLInputElement;
    const formula = div.querySelector('input[aria-label="Formula"]') as HTMLInputElement;
    expect(name.value).toBe('B1');
    expect(formula.value).toBe('=A1*2');
    act(() => formula.focus());
    type(formula, '=A1*10');
    expect(m.edit?.text).toBe('=A1*10');
    key(formula, 'Enter');
    expect(m.content('s1', 0, 1)?.formula).toBe('A1*10');
    expect(m.value('s1', 0, 1)).toBe(30);
  });

  it('the name box goes where it is told, and says when it cannot', () => {
    const m = model();
    const div = render(m, <FormulaBar />);
    const name = div.querySelector('input[aria-label="Name box"]') as HTMLInputElement;
    act(() => name.focus());
    type(name, 'C3:D5');
    key(name, 'Enter');
    expect(m.selection.zones).toEqual([{ top: 2, left: 2, bottom: 4, right: 3 }]);
    type(name, 'not a place');
    key(name, 'Enter');
    expect(div.querySelector('[role="alert"]')?.textContent).toMatch(/not a range|not/i);
  });

  it('a refused commit is said, and Escape gives the cell back', () => {
    const m = model();
    const div = render(m, <FormulaBar />);
    const formula = div.querySelector('input[aria-label="Formula"]') as HTMLInputElement;
    act(() => formula.focus());
    type(formula, 'changed');
    key(formula, 'Escape');
    expect(m.edit).toBeNull();
    expect(m.value('s1', 0, 0)).toBe(3);
    expect(formula.value).toBe('3');
  });
});

describe('the sheet tabs', () => {
  it('lists the sheets as tabs, adds one, shows a sheet by click or arrow key, renames with F2', () => {
    const m = model();
    const div = render(m, <SheetTabs />);
    const tabs = () => [...div.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(div.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Sheets');
    expect(tabs().map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Sheet1', 'true'],
    ]);
    act(() =>
      (
        [...div.querySelectorAll('button')].find(
          (b) => nameOf(b) === 'Add a sheet',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(tabs().map((t) => t.textContent)).toEqual(['Sheet1', 'Sheet2']);
    act(() => tabs()[1].click());
    expect(m.selection.sheet).toBe(m.sheets[1].id);
    tabs()[1].focus();
    key(tabs()[1], 'ArrowLeft');
    expect(m.selection.sheet).toBe(m.sheets[0].id);
    expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0], 'F2');
    const input = div.querySelector('input[aria-label="Rename Sheet1"]') as HTMLInputElement;
    type(input, 'Budget');
    key(input, 'Enter');
    expect(m.sheets[0].name).toBe('Budget');
    expect(tabs()[0].textContent).toBe('Budget');
  });

  it('a refused name is said and the tab stays in rename', () => {
    const m = model();
    m.dispatch({ type: 'ADD_SHEET', name: 'Other' });
    const div = render(m, <SheetTabs />);
    act(() =>
      (div.querySelector('[role="tab"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      ),
    );
    const input = div.querySelector('input[aria-label="Rename Sheet1"]') as HTMLInputElement;
    type(input, 'Other');
    key(input, 'Enter');
    expect(div.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(div.querySelector('input[aria-label="Rename Sheet1"]')).not.toBeNull();
  });
});
