/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The code editor overlay (C11-06): a double-click, Enter, F2 or F4 on a
 * code cell opens Primer's Overlay at the cell holding the contributed
 * editor (jupyter-react's `Cell`, mocked here) and never the grid's own
 * text editor; an edit lands in the grid cell as one undo step when the
 * overlay closes (Escape, *Save*); Shift+Enter in it saves and runs the
 * cell; focus returns to the grid.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { contribution, definePlugin } from '@datalayer/reactor';
import {
  CellsCodeRenderer,
  codeCell,
  type CodeEditorRendererProps,
  codeRunner,
  createCellsModel,
  Spreadsheet,
} from '../../index.js';
import { headerSizes } from '../../render/viewport.js';

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
  document.body.innerHTML = '';
});

const LIMITS = { rows: 100, cols: 20 };

/** A stand-in for jupyter-react's `Cell`: a textarea that registers its save with the overlay. */
function MockCell({ model, sheet, row, col, register }: CodeEditorRendererProps) {
  const m = model as ReturnType<typeof createCellsModel>;
  const code = m.code(sheet, row, col)!;
  let text = code.source;
  register?.({
    save: () => {
      const current = m.code(sheet, row, col);
      if (current !== undefined && text !== current.source)
        m.dispatch({ type: 'SET_CODE', sheet, row, col, code: { ...current, source: text } });
    },
  });
  return (
    <textarea
      data-test-editor={`${row},${col}`}
      defaultValue={code.source}
      onChange={(e) => {
        text = e.target.value;
      }}
    />
  );
}

const CellPlugin = definePlugin({
  name: 'mock-cell',
  contributes: [
    contribution(
      CellsCodeRenderer,
      { id: 'mock', output: () => null, editor: MockCell },
      { id: 'mock' },
    ),
  ],
});

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function mount(plugins: readonly unknown[] = []) {
  const m = createCellsModel({ limits: LIMITS, plugins: plugins as never });
  m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 1, col: 1, code: codeCell('1 + 1') });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 3, col: 1 }, cells: [['plain']] });
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(<Spreadsheet model={m} />));
  await tick();
  const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
  act(() => grid.focus());
  return { m, div, grid };
}

const select = (m: ReturnType<typeof createCellsModel>, row: number, col: number) =>
  act(() =>
    m.select({
      sheet: 's1',
      zones: [{ top: row, left: col, bottom: row, right: col }],
      anchor: { row, col },
      active: { row, col },
    }),
  );

const press = (el: HTMLElement, init: KeyboardEventInit) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });

/** The middle of a cell, in the grid's view px (the default sizes, the headers shown). */
function middleOf(row: number, col: number) {
  const h = headerSizes(LIMITS.rows, true);
  return { clientX: h.width + col * 100 + 50, clientY: h.height + row * 21 + 10 };
}

const overlay = (div: HTMLElement) => div.querySelector<HTMLElement>('[data-cells-code-overlay]');

describe('the code editor overlay', () => {
  it('a double-click on a code cell opens the contributed editor at the cell, never the grid’s text editor', async () => {
    const { m, div, grid } = await mount([CellPlugin]);
    act(() => {
      grid.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...middleOf(1, 1),
        }),
      );
    });
    await tick();
    expect(m.edit).toBeNull();
    expect(overlay(div)).not.toBeNull();
    expect(overlay(div)!.closest('[role="dialog"]')!.getAttribute('aria-label')).toBe('Code of B2');
    expect(div.querySelector('[data-test-editor="1,1"]')).not.toBeNull();
    // A plain cell still gets the grid's editor.
    press(grid, { key: 'Escape' });
    await tick();
    act(() => {
      grid.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...middleOf(3, 1),
        }),
      );
    });
    expect(m.edit).toEqual(expect.objectContaining({ row: 3, col: 1 }));
  });

  it('Enter, F2 and F4 open it on a code cell; Enter moves down on a plain cell', async () => {
    const { m, div, grid } = await mount([CellPlugin]);
    for (const key of ['Enter', 'F2', 'F4']) {
      select(m, 1, 1);
      press(grid, { key });
      await tick();
      expect(div.querySelector('[data-test-editor="1,1"]'), key).not.toBeNull();
      expect(m.edit).toBeNull();
      press(overlay(div)!, { key: 'Escape' });
      await tick();
      expect(overlay(div), key).toBeNull();
    }
    select(m, 3, 1);
    press(grid, { key: 'Enter' });
    expect(m.selection.active).toEqual({ row: 4, col: 1 });
  });

  it('an edit lands in the grid cell as one undo step when the overlay closes, and focus returns to the grid', async () => {
    const { m, div, grid } = await mount();
    select(m, 1, 1);
    press(grid, { key: 'F4' });
    await tick();
    const area = div.querySelector<HTMLTextAreaElement>('[data-cells-code-editor] textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(area, '2 + 2');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    press(area, { key: 'Escape' });
    await tick();
    expect(overlay(div)).toBeNull();
    expect(m.code('s1', 1, 1)?.source).toBe('2 + 2');
    expect(document.activeElement).toBe(grid);
    m.undo();
    expect(m.code('s1', 1, 1)?.source).toBe('1 + 1');
  });

  it('Shift+Enter in the overlay saves the source and runs the cell as the grid does', async () => {
    const { m, div, grid } = await mount([CellPlugin]);
    const run = vi.spyOn(codeRunner(m), 'run').mockResolvedValue(undefined);
    select(m, 1, 1);
    press(grid, { key: 'F4' });
    await tick();
    const area = div.querySelector<HTMLTextAreaElement>('[data-test-editor="1,1"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(area, '3 + 3');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    press(area, { key: 'Enter', shiftKey: true });
    expect(m.code('s1', 1, 1)?.source).toBe('3 + 3');
    expect(run).toHaveBeenCalledWith({ sheet: 's1', row: 1, col: 1 });
    // The grid did not see the key: the selection stayed.
    expect(m.selection.active).toEqual({ row: 1, col: 1 });
    expect(overlay(div)).not.toBeNull();
  });
});
