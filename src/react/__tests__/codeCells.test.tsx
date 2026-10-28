/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * A code cell in the grid's mirror (C11-02): "Code, last run 10:42, result
 * 46"; before its first run, its source's first line; running; stale.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CellsProvider,
  codeCell,
  createCellsModel,
  Spreadsheet,
  useCodeCell,
} from '../../index.js';

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

describe('code cells in the mirror', () => {
  it('names a code cell by its run, its result, its state', () => {
    const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
    const lastRun = new Date(2026, 9, 28, 10, 42).toISOString();
    const set = (
      row: number,
      fields: Parameters<typeof codeCell>[1],
      source = 'sum(cells["A1:A3"])',
    ) => m.dispatch({ type: 'SET_CODE', sheet: 's1', row, col: 1, code: codeCell(source, fields) });
    set(0, { result: 46, lastRun });
    set(1, {}, 'import pandas as pd\ndf = cells["A1:A3"]');
    set(2, { result: 46, lastRun });
    set(3, { result: { error: '#ERROR!' }, lastRun }, '1/0');
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    act(() => root!.render(<Spreadsheet model={m} />));
    const names = () => [...div.querySelectorAll('[role="gridcell"]')].map((c) => c.textContent);
    expect(names()).toContain('Code, last run 10:42, result 46');
    expect(names()).toContain('Code, not run, import pandas as pd');
    expect(names()).toContain('Code, last run 10:42, result #ERROR!, the code raised an error');
    act(() => m.setCodeState('s1', 2, 1, 'stale'));
    expect(names()).toContain('Code, last run 10:42, stale, result 46');
    act(() => m.setCodeState('s1', 2, 1, 'running'));
    expect(names()).toContain('Code, running');
  });

  it('useCodeCell reads a code cell and its state, and sets both', () => {
    const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
    let seen: ReturnType<typeof useCodeCell> | undefined;
    function Probe() {
      seen = useCodeCell('C2');
      return null;
    }
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    act(() =>
      root!.render(
        <CellsProvider model={m}>
          <Probe />
        </CellsProvider>,
      ),
    );
    expect(seen!.code).toBeUndefined();
    act(() => {
      seen!.setCode(codeCell('6*7', { result: 42 }));
    });
    expect(seen!.code?.source).toBe('6*7');
    expect(m.value('s1', 1, 2)).toBe(42);
    act(() => seen!.setState('stale'));
    expect(seen!.state).toBe('stale');
  });
});
