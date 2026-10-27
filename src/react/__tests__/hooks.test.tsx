/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

import { contribution, definePlugin } from '@datalayer/reactor';
import { act, version as reactVersion } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CellsFunctions,
  CellsProvider,
  type CellsModel,
  createCellsModel,
  useAxis,
  useCell,
  useCellValue,
  useCells,
  useCellsFromRows,
  useCellsStats,
  useCommand,
  useContributions,
  useHistory,
  usePlugin,
  useRange,
  useSelection,
  useSheets,
  useStyle,
} from '../../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

/** Render a hook under a provider; returns a getter of its latest value. */
function renderHook<T>(model: CellsModel, hook: () => T): () => T {
  let latest: T;
  function Probe() {
    latest = hook();
    return null;
  }
  const div = document.createElement('div');
  const root = createRoot(div);
  act(() =>
    root.render(
      <CellsProvider model={model}>
        <Probe />
      </CellsProvider>,
    ),
  );
  cleanup = () => act(() => root.unmount());
  return () => latest;
}

describe(`the React hooks (React ${reactVersion})`, () => {
  it('reads cells and ranges, and re-renders when they change', () => {
    const model = createCellsModel({ limits: { rows: 50, cols: 10 } });
    const read = renderHook(model, () => ({
      b2: useCellValue('B2'),
      range: useRange('A1:B2'),
      cell: useCell('Sheet1!B2'),
    }));
    expect(read().b2).toBeNull();
    act(() => {
      model.dispatch({
        type: 'SET_CELLS',
        sheet: 's1',
        at: { row: 0, col: 0 },
        cells: [
          [1, 2],
          [3, 4],
        ],
      });
    });
    expect(read().b2).toBe(4);
    expect(read().range).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(read().cell.content).toEqual({ value: 4, style: 0 });
  });

  it('runs commands, undo and redo', () => {
    const model = createCellsModel({ limits: { rows: 50, cols: 10 } });
    const read = renderHook(model, () => ({
      set: useCommand('SET_CELLS'),
      history: useHistory(),
      a1: useCellValue('A1'),
    }));
    act(() => {
      expect(read().set({ sheet: 's1', at: { row: 0, col: 0 }, cells: [['x']] })).toEqual({
        ok: true,
      });
    });
    expect(read().a1).toBe('x');
    expect(read().history.canUndo).toBe(true);
    expect(read().history.undoLabel).toBe('SET_CELLS');
    act(() => {
      read().history.undo();
    });
    expect(read().a1).toBeNull();
    expect(read().history.canRedo).toBe(true);
    const refused = read().set({ sheet: 'nope', at: { row: 0, col: 0 }, cells: [[1]] });
    expect(refused.ok).toBe(false);
  });

  it('selects and navigates', () => {
    const model = createCellsModel({ limits: { rows: 50, cols: 10 } });
    const read = renderHook(model, () => useSelection());
    act(() => read().select('C3'));
    expect(read().active).toEqual({ row: 2, col: 2 });
    act(() => read().navigate({ type: 'move', dir: 'down', extend: true }));
    expect(read().zones).toEqual([{ top: 2, left: 2, bottom: 3, right: 2 }]);
  });

  it('lists, adds and renames sheets; reads an axis; styles a cell', () => {
    const model = createCellsModel({ limits: { rows: 50, cols: 10 } });
    const read = renderHook(model, () => ({
      sheets: useSheets(),
      axis: useAxis('s1', 'cols'),
      style: useStyle('A1'),
    }));
    act(() => {
      read().sheets.add('Budget');
    });
    expect(read().sheets.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Budget']);
    act(() => {
      read().axis.resize(0, 0, 150);
    });
    expect(read().axis.sizeOf(0)).toBe(150);
    expect(read().axis.offsetOf(1)).toBe(150);
    act(() => {
      read().style.set({ bold: true });
    });
    expect(read().style.style).toEqual({ bold: true });
  });

  it('follows plugins being switched on and off', () => {
    const Fx = definePlugin({
      name: '@acme/fx',
      contributes: [
        contribution(CellsFunctions, {
          name: 'FX',
          args: [],
          returns: 'number',
          compute: () => 1,
          category: 'math',
          description: 'One.',
          examples: ['=FX()'],
        }),
      ],
    });
    const model = createCellsModel({ plugins: [Fx], limits: { rows: 50, cols: 10 } });
    const read = renderHook(model, () => ({
      plugin: usePlugin('@acme/fx'),
      functions: useContributions(CellsFunctions),
    }));
    expect(read().plugin.enabled).toBe(true);
    expect(read().functions.map((c) => c.value.name)).toContain('FX');
    act(() => read().plugin.disable());
    expect(read().plugin.enabled).toBe(false);
    expect(read().functions.map((c) => c.value.name)).not.toContain('FX');
  });

  it('creates a model from rows once, and reports its counters', () => {
    let created: CellsModel | undefined;
    function Host() {
      created = useCellsFromRows([[1, 2, 3]], { limits: { rows: 10, cols: 10 } });
      return (
        <CellsProvider model={created}>
          <Inner />
        </CellsProvider>
      );
    }
    let stats: ReturnType<typeof useCellsStats> | undefined;
    function Inner() {
      stats = useCellsStats();
      return null;
    }
    const div = document.createElement('div');
    const root = createRoot(div);
    act(() => root.render(<Host />));
    const first = created;
    act(() => root.render(<Host />));
    expect(created).toBe(first);
    expect(stats?.cells).toBe(3);
    act(() => root.unmount());
  });

  it('refuses a hook outside a provider, with a sentence', () => {
    function Lost() {
      useCells();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    expect(() => act(() => root.render(<Lost />))).toThrow(/<CellsProvider> or a <Spreadsheet>/);
  });
});
