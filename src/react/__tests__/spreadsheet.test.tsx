/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

import { act, createRef, StrictMode, version as reactVersion } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CellsHandle,
  type CellsModel,
  createCellsModel,
  fromRows,
  MIRROR_CAP,
  Spreadsheet,
} from '../../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom draws nothing: a 2D context that accepts every call, and a ResizeObserver that reports a size once. */
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
});

function mount(node: React.ReactNode): HTMLDivElement {
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(node));
  return div;
}

describe(`<Spreadsheet> (React ${reactVersion})`, () => {
  it("is a grid with the sheet's full counts, and mirrors the visible cells with their names", () => {
    const div = mount(
      <Spreadsheet
        defaultData={fromRows([
          ['Item', 42],
          [true, { error: '#DIV/0!' }],
        ])}
        aria-label="Budget"
      />,
    );
    const grid = div.querySelector('[role="grid"]')!;
    expect(grid.getAttribute('aria-label')).toBe('Budget');
    expect(grid.getAttribute('aria-rowcount')).toBe(String(1_048_576 + 1));
    expect(grid.getAttribute('aria-colcount')).toBe(String(16_384 + 1));
    const cells = [...div.querySelectorAll('[role="gridcell"]')];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(MIRROR_CAP);
    const active = document.getElementById(grid.getAttribute('aria-activedescendant')!)!;
    expect(active.textContent).toBe('Item');
    expect(active.getAttribute('aria-selected')).toBe('true');
    const names = cells.map((c) => c.textContent);
    expect(names).toContain('TRUE');
    expect(names).toContain('#DIV/0!, division by zero');
  });

  it('moves the active cell with the keyboard, and announces edits', async () => {
    const model = createCellsModel();
    const div = mount(<Spreadsheet model={model} />);
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    act(() => {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(model.selection.active).toEqual({ row: 1, col: 1 });
    expect(document.getElementById(grid.getAttribute('aria-activedescendant')!)).not.toBeNull();
    act(() => {
      model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [['x']] });
    });
    expect(div.querySelector('[aria-live="polite"]')!.textContent).toBe('Edited B2');
  });

  it('offers the imperative handle', () => {
    const ref = createRef<CellsHandle>();
    mount(<Spreadsheet ref={ref} />);
    const h = ref.current!;
    act(() => h.select('C3:D4'));
    expect(h.getSelection().zones).toEqual([{ top: 2, left: 2, bottom: 3, right: 3 }]);
    act(() => {
      h.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[1]] });
    });
    expect(h.toJSON().sheets[0].rows['0'].cells['0']).toEqual({ v: 1 });
    act(() => {
      h.undo();
    });
    expect(h.model.value('s1', 0, 0)).toBeNull();
    const rejected = vi.fn();
    root!.unmount();
    root = undefined;
    const ref2 = createRef<CellsHandle>();
    mount(<Spreadsheet ref={ref2} onCommandRejected={rejected} />);
    ref2.current!.dispatch({
      type: 'SET_CELLS',
      sheet: 'nope',
      at: { row: 0, col: 0 },
      cells: [[1]],
    });
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('refuses model and defaultData together, and a switch between them', () => {
    const model = createCellsModel();
    expect(() => mount(<Spreadsheet model={model} defaultData={fromRows([[1]])} />)).toThrow(
      /not both/,
    );
    root = undefined;
    const div = document.createElement('div');
    root = createRoot(div);
    act(() => root!.render(<Spreadsheet defaultData={fromRows([[1]])} />));
    expect(() => act(() => root!.render(<Spreadsheet model={model} />))).toThrow(
      /switched from uncontrolled to controlled/,
    );
    root = undefined;
  });

  it("survives Strict Mode, and a remount keeps the host's model as it was", () => {
    const model: CellsModel = createCellsModel();
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [['kept']] });
    mount(
      <StrictMode>
        <Spreadsheet model={model} />
      </StrictMode>,
    );
    act(() => root!.unmount());
    root = undefined;
    expect(model.value('s1', 0, 0)).toBe('kept');
    const div = mount(<Spreadsheet model={model} />);
    expect(div.querySelector('[role="gridcell"]')!.textContent).toBe('kept');
  });

  it('is two independent grids on one page', () => {
    const a = createCellsModel();
    const b = createCellsModel();
    const div = mount(
      <>
        <Spreadsheet model={a} aria-label="A" />
        <Spreadsheet model={b} aria-label="B" />
      </>,
    );
    const [ga, gb] = div.querySelectorAll<HTMLElement>('[role="grid"]');
    act(() => {
      ga.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      gb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(a.selection.active).toEqual({ row: 1, col: 0 });
    expect(b.selection.active).toEqual({ row: 0, col: 1 });
    expect(ga.getAttribute('aria-activedescendant')).not.toBe(
      gb.getAttribute('aria-activedescendant'),
    );
  });

  it("moves the selection without re-rendering the grid: the mirror's active cell follows", () => {
    const model = createCellsModel();
    const div = mount(<Spreadsheet model={model} />);
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    // The grid's render reads readOnly (aria-readonly); a selection move reads nothing of it.
    let renders = 0;
    Object.defineProperty(model, 'readOnly', {
      configurable: true,
      get: () => {
        renders += 1;
        return false;
      },
    });
    const before = document.getElementById(grid.getAttribute('aria-activedescendant')!)!;
    act(() => {
      model.select({
        ...model.selection,
        anchor: { row: 2, col: 1 },
        active: { row: 2, col: 1 },
        zones: [{ top: 2, left: 1, bottom: 2, right: 1 }],
      });
    });
    expect(renders).toBe(0);
    const active = document.getElementById(grid.getAttribute('aria-activedescendant')!)!;
    expect(active.id).toMatch(/-r2-c1$/);
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(before.getAttribute('aria-selected')).toBe('false');
  });

  it('keeps the mirror as it is while a scroll runs, then re-reads its rows in place', async () => {
    const model = createCellsModel();
    const div = mount(<Spreadsheet model={model} />);
    const scroller = div.querySelector<HTMLElement>('[data-cells-scroller]')!;
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    const rows = () =>
      [...div.querySelectorAll('[data-cells-mirror] [role="row"]')].filter(
        (r) => Number(r.getAttribute('aria-rowindex')) > 1,
      );
    const last = () => Math.max(...rows().map((r) => Number(r.getAttribute('aria-rowindex'))));
    const before = rows();
    const lastBefore = last();
    act(() => {
      top = 2000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    // Mid-scroll the mirror is left alone: re-mounting rows each frame was what a fling cost.
    expect(last()).toBe(lastBefore);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(last()).toBeGreaterThan(lastBefore + 50);
    // The same row elements, re-read: none re-mounted.
    expect(before.every((r) => r.isConnected)).toBe(true);
    // The active cell (A1, scrolled out of view) stays in the mirror for aria-activedescendant.
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    expect(document.getElementById(grid.getAttribute('aria-activedescendant')!)).not.toBeNull();
  });

  it("re-reads the mirror's names in the rows a change touches, and everywhere once a formula may follow it", () => {
    const model = createCellsModel();
    const div = mount(<Spreadsheet model={model} />);
    const name = (ref: string) =>
      [...div.querySelectorAll('[role="gridcell"]')].find((c) => c.id.endsWith(ref))?.textContent;
    act(() => {
      model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[1]] });
    });
    expect(name('-r0-c0')).toBe('1');
    act(() => {
      model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 3, col: 1 }, cells: [['x']] });
    });
    expect(name('-r3-c1')).toBe('x');
    act(() => {
      model.dispatch({
        type: 'SET_CELLS',
        sheet: 's1',
        at: { row: 4, col: 2 },
        cells: [[{ formula: 'A1*2' }]],
      });
    });
    expect(name('-r4-c2')).toBe('2, formula: =A1*2');
    // A1 changes in row 0; the formula in row 4 follows it, and its name with it.
    act(() => {
      model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[21]] });
    });
    expect(name('-r0-c0')).toBe('21');
    expect(name('-r4-c2')).toBe('42, formula: =A1*2');
    // A document projected without patches, as a collaboration binding does: every row re-reads.
    const data = model.toJSON();
    act(() => {
      const other = createCellsModel({ data });
      other.dispatch({
        type: 'SET_CELLS',
        sheet: 's1',
        at: { row: 3, col: 1 },
        cells: [['remote']],
      });
      model.replaceData(other.toJSON(), 'remote');
    });
    expect(name('-r3-c1')).toBe('remote');
  });
});
