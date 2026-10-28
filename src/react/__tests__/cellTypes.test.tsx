/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * Cell types in the grid (C7-02): the accessibility mirror names a typed
 * cell as its type says, Space toggles a checkbox and Enter opens a link, a
 * click in the hit area activates, and a type that says so is not typed over.
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { act, version as reactVersion } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CELLS_CELL_TYPES_PLUGIN,
  CellsCellTypes,
  type CellsModel,
  createCellsModel,
  Spreadsheet,
} from '../../index.js';
import { cellRect, computeViewport } from '../../render/viewport.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const canvas = this;
    return new Proxy(
      {},
      {
        get: (_t, key) => {
          if (key === 'canvas') return canvas;
          if (key === 'measureText') return (s: string) => ({ width: s.length * 7 });
          return () => undefined;
        },
        set: () => true,
      },
    ) as never;
  } as never;
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe() {
      this.cb([], this as never);
    }
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 800,
      height: 400,
      right: 800,
      bottom: 400,
      toJSON: () => ({}),
    } as DOMRect;
  };
  globalThis.requestAnimationFrame = (f: FrameRequestCallback) =>
    setTimeout(() => f(0), 0) as unknown as number;
});

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode): HTMLDivElement {
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(node));
  return div;
}

/** A model with a checkbox in A1, a link in B1, a progress bar in C1, and a plain cell in A2. */
function model(): CellsModel {
  const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      [false, 'https://datalayer.io', 0.42],
      ['plain', 'words', 7],
    ],
  });
  for (const [col, type] of [
    [0, 'checkbox'],
    [1, 'link'],
    [2, 'progress'],
  ] as const)
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 0, left: col, bottom: 0, right: col },
      style: { type },
    });
  return m;
}

const key = (grid: HTMLElement, key: string) =>
  act(() => {
    grid.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

/** A1's rectangle in the grid, as the renderer lays it out at 800 × 400. */
function boxOf(m: CellsModel, row: number, col: number) {
  const sheet = m.sheet('s1');
  const vp = computeViewport({
    rows: sheet.rows,
    cols: sheet.cols,
    frozen: sheet.frozen,
    scrollX: 0,
    scrollY: 0,
    width: 800,
    height: 400,
    zoom: 1,
    showHeaders: true,
  });
  const main = vp.panes.find((p) => p.name === 'main')!;
  return cellRect(main, 1, sheet.rows, sheet.cols, row, col);
}

const click = (grid: HTMLElement, x: number, y: number) =>
  act(() => {
    grid.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }),
    );
  });

describe(`cell types in the grid (React ${reactVersion})`, () => {
  it('names typed cells in the mirror as their type says, and plainly once the plugin is off', () => {
    const m = model();
    const div = mount(<Spreadsheet model={m} />);
    const names = () => [...div.querySelectorAll('[role="gridcell"]')].map((c) => c.textContent);
    expect(names()).toContain('not checked');
    expect(names()).toContain('https://datalayer.io, link');
    expect(names()).toContain('42 percent');
    act(() => m.reactor.disable(CELLS_CELL_TYPES_PLUGIN));
    expect(names()).toContain('FALSE');
    expect(names()).toContain('https://datalayer.io');
    expect(names()).toContain('0.42');
    expect(names()).not.toContain('not checked');
  });

  it('toggles a checkbox with Space (undoable), and lets Space type into a plain cell', () => {
    const m = model();
    const div = mount(<Spreadsheet model={m} />);
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    key(grid, ' ');
    expect(m.value('s1', 0, 0)).toBe(true);
    expect(m.edit).toBeNull();
    key(grid, ' ');
    expect(m.value('s1', 0, 0)).toBe(false);
    act(() => {
      expect(m.undo()).toBe(true);
    });
    expect(m.value('s1', 0, 0)).toBe(true);
    // Enter on the checkbox moves down, as on any cell.
    key(grid, 'Enter');
    expect(m.selection.active).toEqual({ row: 1, col: 0 });
    key(grid, ' ');
    expect(m.edit).toEqual({ sheet: 's1', row: 1, col: 0, text: ' ' });
  });

  it('opens a link with Enter in a new tab with no opener, and moves down from a plain cell', () => {
    const m = model();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const div = mount(<Spreadsheet model={m} />);
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    key(grid, 'ArrowRight');
    expect(m.selection.active).toEqual({ row: 0, col: 1 });
    key(grid, 'Enter');
    expect(open).toHaveBeenCalledWith('https://datalayer.io', '_blank', 'noopener,noreferrer');
    expect(m.selection.active).toEqual({ row: 0, col: 1 });
    // Text that is no URL opens nothing; the type still takes the key.
    act(() => {
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 1 }, cells: [['words']] });
    });
    key(grid, 'Enter');
    expect(open).toHaveBeenCalledTimes(1);
    // Space on a link types, as on any cell: the link takes Enter only.
    key(grid, ' ');
    expect(m.edit?.text).toBe(' ');
  });

  it('activates on a click in the hit area only, after selecting the cell', () => {
    const m = model();
    const div = mount(<Spreadsheet model={m} />);
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    const a1 = boxOf(m, 0, 0);
    // The square sits in the middle of the cell: a click at the left edge selects only.
    click(grid, a1.x + 3, a1.y + a1.height / 2);
    expect(m.selection.active).toEqual({ row: 0, col: 0 });
    expect(m.value('s1', 0, 0)).toBe(false);
    click(grid, a1.x + a1.width / 2, a1.y + a1.height / 2);
    expect(m.value('s1', 0, 0)).toBe(true);
    // A link has no hit area of its own: anywhere in the cell opens it.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const b1 = boxOf(m, 0, 1);
    click(grid, b1.x + 2, b1.y + 2);
    expect(open).toHaveBeenCalledWith('https://datalayer.io', '_blank', 'noopener,noreferrer');
    expect(m.selection.active).toEqual({ row: 0, col: 1 });
  });

  it('refuses a toggle on a read-only workbook and says so; a type that is not editable is not typed over', () => {
    const Stars = definePlugin({
      name: '@acme/stars',
      contributes: [
        contribution(
          CellsCellTypes,
          {
            id: 'stars',
            editable: false,
            activateOn: ['+'],
            render: () => undefined,
            activate: (cell, value) => ({
              command: {
                type: 'SET_CELLS',
                sheet: cell.sheet,
                at: { row: cell.row, col: cell.col },
                cells: [[(typeof value === 'number' ? value : 0) + 1]],
              },
            }),
            accessibleName: (value) => `${String(value)} stars`,
          },
          { id: 'stars' },
        ),
      ],
    });
    const m = createCellsModel({ plugins: [Stars], limits: { rows: 10, cols: 5 } });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[3]] });
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 0, left: 0, bottom: 0, right: 0 },
      style: { type: 'stars' },
    });
    const div = mount(<Spreadsheet model={m} />);
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    expect([...div.querySelectorAll('[role="gridcell"]')].map((c) => c.textContent)).toContain(
      '3 stars',
    );
    key(grid, 'x');
    expect(m.edit).toBeNull();
    key(grid, '+');
    expect(m.value('s1', 0, 0)).toBe(4);
    key(grid, 'F2');
    expect(m.edit?.text).toBe('4');
    act(() => m.cancelEdit());

    const ro = createCellsModel({ readOnly: true, data: model().toJSON() });
    const rejected = vi.fn();
    const div2 = mount(<Spreadsheet model={ro} onCommandRejected={rejected} />);
    const grid2 = div2.querySelector<HTMLElement>('[role="grid"]')!;
    key(grid2, ' ');
    expect(ro.value('s1', 0, 0)).toBe(false);
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        refusals: [expect.objectContaining({ reason: 'ReadOnly' })],
      }),
    );
    expect(div2.querySelector('[aria-live="polite"]')!.textContent).toBe(
      'The workbook is read-only.',
    );
  });
});
