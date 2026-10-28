/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * C10-04 (jsdom): dragging a chart's frame moves it, dragging a handle
 * resizes it (a left or top handle moves it too, in one step), with Alt it
 * snaps to the cell edges; `dragCommands` is the pure part.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ChartSpec, createCellsModel, type Transaction } from '../../core/index.js';
import { dragCommands } from '../../react/ChartsLayer.js';
import { Spreadsheet } from '../../react/Spreadsheet.js';

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
      width: 1200,
      height: 600,
      right: 1200,
      bottom: 600,
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

const spec: Omit<ChartSpec, 'id'> & { id: string } = {
  id: 'c',
  type: 'column',
  anchor: {
    kind: 'cells',
    from: { row: 2, col: 4, dx: 0, dy: 0 },
    to: { row: 8, col: 8, dx: 0, dy: 0 },
  },
  data: {
    series: [{ values: 'Sheet1!$B$2:$B$4' }],
    by: 'columns',
    headers: { row: false, column: false },
    blanks: 'gap',
  },
  legend: 'none',
};

async function mount() {
  const model = createCellsModel({ limits: { rows: 100, cols: 30 } });
  model.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
    ],
  });
  model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec });
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  await act(async () => root!.render(<Spreadsheet model={model} theme="auto" />));
  for (let i = 0; i < 50 && div.querySelector('[data-cells-chart="c"]') === null; i += 1)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  const frame = div.querySelector('[data-cells-chart="c"]') as HTMLElement;
  return { model, div, holder: frame.parentElement as HTMLElement };
}

const pointer = (el: Element, type: string, x: number, y: number, init: MouseEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...init }),
    );
  });

describe('dragging a chart', () => {
  it('the frame: a drag moves it by whole cells; a short drag does nothing', async () => {
    const { model, holder } = await mount();
    const s = model.sheet('s1');
    const seen: Transaction[] = [];
    model.subscribe((tx) => seen.push(tx));
    await pointer(holder, 'pointerdown', 100, 100);
    await pointer(holder, 'pointerup', 100 + 2 * s.cols.defaultSize, 100 + 3 * s.rows.defaultSize);
    expect(seen.map((t) => t.label)).toEqual(['MOVE_CHART']);
    expect(s.charts.get('c')!.anchor).toMatchObject({
      from: { row: 5, col: 6 },
      to: { row: 11, col: 10 },
    });
    await pointer(holder, 'pointerdown', 100, 100);
    await pointer(holder, 'pointerup', 101, 101);
    expect(seen).toHaveLength(1);
    expect(model.selectedChart).toBe('c');
  });

  it('the handles: south-east resizes, north-west moves and resizes in one step, with eight handles shown when selected', async () => {
    const { model, holder } = await mount();
    const s = model.sheet('s1');
    model.selectChart('c');
    await act(async () => {});
    const handles = [...holder.querySelectorAll('[data-cells-chart-handle]')];
    expect(handles.map((h) => h.getAttribute('data-cells-chart-handle'))).toEqual([
      'nw',
      'n',
      'ne',
      'w',
      'e',
      'sw',
      's',
      'se',
    ]);
    const seen: Transaction[] = [];
    model.subscribe((tx) => seen.push(tx));
    const se = handles.find((h) => h.getAttribute('data-cells-chart-handle') === 'se')!;
    await pointer(se, 'pointerdown', 300, 300);
    await pointer(holder, 'pointerup', 300 + 2 * s.cols.defaultSize, 300 - s.rows.defaultSize);
    expect(seen.map((t) => t.label)).toEqual(['RESIZE_CHART']);
    expect(s.charts.get('c')!.anchor).toMatchObject({
      from: { row: 2, col: 4 },
      to: { row: 7, col: 10 },
    });
    const nw = handles.find((h) => h.getAttribute('data-cells-chart-handle') === 'nw')!;
    await pointer(nw, 'pointerdown', 100, 100);
    await pointer(holder, 'pointerup', 100 + s.cols.defaultSize, 100 + s.rows.defaultSize);
    expect(seen.map((t) => t.label)).toEqual(['RESIZE_CHART', 'Resize chart']);
    expect(seen[1].commands.map((c) => c.type)).toEqual(['MOVE_CHART', 'RESIZE_CHART']);
    expect(s.charts.get('c')!.anchor).toMatchObject({
      from: { row: 3, col: 5 },
      to: { row: 7, col: 10 },
    });
    model.undo();
    expect(s.charts.get('c')!.anchor).toMatchObject({
      from: { row: 2, col: 4 },
      to: { row: 7, col: 10 },
    });
  });

  it('dragCommands: an absolute chart moves and resizes in px; a px-sized cell anchor resizes in px', () => {
    const model = createCellsModel({ limits: { rows: 100, cols: 30 } });
    const s = model.sheet('s1');
    const abs: ChartSpec = {
      ...spec,
      anchor: { kind: 'absolute', x: 50, y: 60, width: 300, height: 200 },
    };
    const drag = {
      id: 'c',
      handle: 'move' as const,
      startX: 0,
      startY: 0,
      pointerId: 1,
      rect: { x: 50, y: 60, width: 300, height: 200 },
    };
    expect(dragCommands(s, abs, drag, 10, -70, false)).toEqual({ move: { x: 60, y: 0 } });
    expect(dragCommands(s, abs, { ...drag, handle: 'se' }, 10, 20, false)).toEqual({
      resize: { width: 310, height: 220 },
    });
    expect(dragCommands(s, abs, { ...drag, handle: 'w' }, 20, 0, false)).toEqual({
      move: { x: 70, y: 60 },
      resize: { width: 280, height: 200 },
    });
    const cell: ChartSpec = {
      ...spec,
      anchor: { kind: 'cell', from: { row: 1, col: 1, dx: 0, dy: 0 }, width: 200, height: 100 },
    };
    const rect = { x: s.cols.offsetOf(1), y: s.rows.offsetOf(1), width: 200, height: 100 };
    expect(dragCommands(s, cell, { ...drag, rect, handle: 'e' }, 30, 0, false)).toEqual({
      resize: { width: 230, height: 100 },
    });
    expect(
      dragCommands(s, cell, { ...drag, rect, handle: 'move' }, s.cols.defaultSize, 0, false),
    ).toEqual({ move: { row: 1, col: 2 } });
  });
});
