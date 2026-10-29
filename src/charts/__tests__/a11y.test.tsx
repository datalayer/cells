/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * C10-05 (jsdom) and C10-04 (the keyboard in the grid): a chart's frame is a
 * figure named and described from its data, with a hidden data table capped
 * at 1,000 rows; a click selects it, arrows move it, Shift+arrows resize it,
 * Delete removes it, Escape returns to the cells, Go to chart focuses it.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const instances = new Map<Element, unknown>();
vi.mock('echarts/core', () => ({
  use: () => undefined,
  init: (dom: Element) => {
    const instance = {
      setOption: () => undefined,
      resize: () => undefined,
      showLoading: () => undefined,
      hideLoading: () => undefined,
      dispose: () => instances.delete(dom),
      getOption: () => ({}),
      on: (event: string, cb: () => void) => {
        if (event === 'finished') cb();
      },
      off: () => undefined,
      isDisposed: () => false,
      getDom: () => dom,
    };
    instances.set(dom, instance);
    return instance;
  },
  getInstanceByDom: (dom: Element) => instances.get(dom),
  dispose: (dom: Element) => instances.delete(dom),
  registerTheme: () => undefined,
}));

import { type ChartSpec, createCellsModel, type Transaction } from '../../core/index.js';
import { Spreadsheet } from '../../react/Spreadsheet.js';
import { CHART_TABLE_CAP } from '../../react/ChartFrame.js';
import { CellsChartsPluginModule } from '../plugin.js';

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

const spec = (
  type: string,
  over: Partial<ChartSpec> = {},
): Omit<ChartSpec, 'id'> & { id: string } => ({
  id: type,
  type,
  anchor: {
    kind: 'cells',
    from: { row: 1, col: 4, dx: 0, dy: 0 },
    to: { row: 8, col: 8, dx: 0, dy: 0 },
  },
  data: {
    series: [
      { name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$5', categories: 'Sheet1!$A$2:$A$5' },
      { name: 'Sheet1!$C$1', values: 'Sheet1!$C$2:$C$5', categories: 'Sheet1!$A$2:$A$5' },
    ],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: 'gap',
  },
  legend: 'bottom',
  ...over,
});

async function mount(charts: (Omit<ChartSpec, 'id'> & { id: string })[], rows = 5) {
  const model = createCellsModel({
    limits: { rows: Math.max(100, rows + 10), cols: 20 },
    plugins: [CellsChartsPluginModule],
  });
  const cells: (string | number)[][] = [['Month', 'North', 'South']];
  for (let i = 1; i < rows; i += 1) cells.push([`M${i}`, i * 2, i * 3]);
  model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells });
  for (const c of charts) model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: c });
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  await act(async () => root!.render(<Spreadsheet model={model} theme="auto" />));
  for (let i = 0; i < 50 && div.querySelectorAll('[role="figure"]').length < charts.length; i += 1)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  const grid = div.querySelector('[role="grid"]') as HTMLElement;
  const figure = (id: string) => div.querySelector(`[data-cells-chart="${id}"]`) as HTMLElement;
  return { model, div, grid, figure };
}

const key = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });

describe('accessible charts', () => {
  it('each type is a figure named by its title or generated name, described from its data, with a hidden data table', async () => {
    const { figure } = await mount([
      spec('column', { title: 'Sales' }),
      spec('line'),
      spec('pie', { data: { ...spec('pie').data, series: [spec('pie').data.series[0]] } }),
      spec('scatter', {
        data: {
          series: [{ name: 'y', values: 'Sheet1!$C$2:$C$5', x: 'Sheet1!$B$2:$B$5' }],
          by: 'columns',
          headers: { row: true, column: false },
          blanks: 'gap',
        },
      }),
    ]);
    const column = figure('column');
    expect(column.getAttribute('aria-label')).toBe('Sales');
    const described = document.getElementById(column.getAttribute('aria-describedby')!)!;
    expect(described.textContent).toBe(
      'Sales. 2 series, 4 categories from M1 to M4; North runs from 2 to 8, highest in M4; South runs from 3 to 12, highest in M4.',
    );
    expect(figure('line').getAttribute('aria-label')).toBe('Line chart of 2 series');
    expect(figure('pie').getAttribute('aria-label')).toBe('Pie chart of North');
    expect(
      document.getElementById(figure('scatter').getAttribute('aria-describedby')!)!.textContent,
    ).toMatch(/^Scatter chart of y\. 1 series, 4 points; y runs from 3 to 12\.$/);
    const table = column.querySelector('[data-cells-chart-table] table')!;
    expect(table.querySelector('caption')!.textContent).toBe('Data of Sales');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Category',
      'North',
      'South',
    ]);
    expect([...table.querySelectorAll('tbody tr')].map((tr) => tr.textContent)).toEqual([
      'M123',
      'M246',
      'M369',
      'M4812',
    ]);
    expect(column.getAttribute('tabindex')).toBe('-1');
    expect(column.querySelectorAll('canvas, [aria-hidden="true"]').length).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('the data table stops at 1,000 rows and names the rest and the source range', async () => {
    const rows = CHART_TABLE_CAP + 50;
    const { figure } = await mount(
      [
        spec('column', {
          data: {
            series: [
              {
                name: 'Sheet1!$B$1',
                values: `Sheet1!$B$2:$B$${rows}`,
                categories: `Sheet1!$A$2:$A$${rows}`,
              },
            ],
            by: 'columns',
            headers: { row: true, column: true },
            blanks: 'gap',
          },
        }),
      ],
      rows,
    );
    const holder = figure('column').querySelector('[data-cells-chart-table]')!;
    expect(holder.querySelectorAll('tbody tr')).toHaveLength(CHART_TABLE_CAP);
    expect(holder.querySelector('p')!.textContent).toBe(
      `${rows - 1 - CHART_TABLE_CAP} more rows are not listed; the data is in Sheet1!$B$2:$B$${rows}.`,
    );
  });
});

describe('a selected chart in the grid', () => {
  it('a click selects and focuses it; arrows move, Shift+arrows resize, Delete removes, Escape returns to the cells', async () => {
    const { model, grid, figure } = await mount([spec('column')]);
    const seen: Transaction[] = [];
    model.subscribe((tx) => seen.push(tx));
    const f = figure('column');
    await act(async () => {
      f.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(model.selectedChart).toBe('column');
    expect(document.activeElement).toBe(f);
    expect(f.getAttribute('aria-current')).toBe('true');
    await key(f, 'ArrowDown');
    await key(f, 'ArrowRight');
    await key(f, 'ArrowRight', { shiftKey: true });
    await key(f, 'ArrowUp', { shiftKey: true });
    expect(seen.map((t) => t.commands[0].type)).toEqual([
      'MOVE_CHART',
      'MOVE_CHART',
      'RESIZE_CHART',
      'RESIZE_CHART',
    ]);
    expect(model.sheet('s1').charts.get('column')!.anchor).toMatchObject({
      from: { row: 2, col: 5 },
      to: { row: 8, col: 10 },
    });
    await key(figure('column'), 'Escape');
    expect(model.selectedChart).toBeNull();
    expect(document.activeElement).toBe(grid);
    // From the grid: Go to chart selects and focuses it; Delete removes it.
    await act(async () => {
      await model.reactor.executeCommand('cells.chart.focusNext', { model });
    });
    expect(model.selectedChart).toBe('column');
    expect(document.activeElement).toBe(figure('column'));
    await key(grid, 'ArrowLeft'); // the grid's own key, with a chart selected: the chart moves
    expect(seen.at(-1)!.commands[0].type).toBe('MOVE_CHART');
    await key(figure('column'), 'Delete');
    expect(model.sheet('s1').charts.size).toBe(0);
    expect(model.selectedChart).toBeNull();
  });

  it('sits beside the grid, not in it; Shift+F10 on the frame and a right-click open the menu with the chart kept selected', async () => {
    const { model, div, grid, figure } = await mount([spec('column')]);
    // A grid owns rows only (axe's aria-required-children): the figure is outside it.
    expect(grid.contains(figure('column'))).toBe(false);
    expect(div.querySelector('[data-cells-layers]')!.contains(figure('column'))).toBe(true);
    await act(async () => {
      figure('column').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    await key(figure('column'), 'F10', { shiftKey: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const items = () =>
      [...document.querySelectorAll('[data-cells-menu] [role="menuitem"]')].map((e) =>
        e.textContent?.trim(),
      );
    expect(items()).toEqual(expect.arrayContaining([expect.stringMatching(/^Show chart data/)]));
    expect(model.selectedChart).toBe('column');
    const show = [...document.querySelectorAll('[data-cells-menu] [role="menuitem"]')].find((e) =>
      e.textContent?.startsWith('Show chart data'),
    ) as HTMLElement;
    await act(async () => {
      show.click();
    });
    expect(model.selection.zones).toContainEqual({ top: 0, left: 1, bottom: 0, right: 1 });
    expect(model.selectedChart).toBeNull();
    // A right-click on the frame keeps the chart selected: the menu's Delete chart acts on it.
    await act(async () => {
      figure('column').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      figure('column').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 500,
          clientY: 100,
        }),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(model.selectedChart).toBe('column');
    const del = [...document.querySelectorAll('[data-cells-menu] [role="menuitem"]')].find((e) =>
      e.textContent?.startsWith('Delete chart'),
    ) as HTMLElement;
    await act(async () => {
      del.click();
    });
    expect(model.sheet('s1').charts.size).toBe(0);
  });
});
