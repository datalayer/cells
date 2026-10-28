/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * C10-03 in jsdom: `<CellsChart>` with `echarts/core` mocked (the modules
 * passed to `use`, the option passed to `setOption`), the placeholder
 * without the plugin, and the grid's chart layer: a chart's frame in its
 * pane's clip, mounted only near the viewport.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const used: unknown[][] = [];
const setOption = vi.fn();
// echarts-for-react 3.0.6 inits a temporary instance, waits for its 'finished'
// event, disposes it and inits again at the measured size; it then finds the
// instance by its DOM node. The mock keeps instances by node and fires
// 'finished' at once.
const instances = new Map<Element, unknown>();
vi.mock('echarts/core', () => ({
  use: (modules: unknown[]) => used.push(modules),
  init: (dom: Element) => {
    const instance = {
      setOption,
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

import { type ChartSpec, createCellsModel } from '../../core/index.js';
import { Spreadsheet } from '../../react/Spreadsheet.js';
import { placeChart, paneOfChart } from '../../react/ChartsLayer.js';
import { computeViewport } from '../../render/viewport.js';
import { BarChart, LineChart } from 'echarts/charts';
import { CellsChart } from '../index.js';
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
  used.length = 0;
  setOption.mockClear();
});

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  await act(async () => root!.render(node));
  // The instance is made on a promise; let it settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return div;
}

const spec = (over: Partial<ChartSpec> = {}): ChartSpec => ({
  id: 'c1',
  type: 'column',
  anchor: {
    kind: 'cells',
    from: { row: 1, col: 3, dx: 0, dy: 0 },
    to: { row: 8, col: 7, dx: 0, dy: 0 },
  },
  data: {
    series: [{ name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$5', categories: 'Sheet1!$A$2:$A$5' }],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: 'gap',
  },
  title: 'Sales',
  legend: 'bottom',
  ...over,
});

function model(plugins: unknown[] = [CellsChartsPluginModule]) {
  const m = createCellsModel({ limits: { rows: 1000, cols: 50 }, plugins: plugins as never });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'North'],
      ['Jan', 10],
      ['Feb', 12],
      ['Mar', 15],
      ['Apr', 13],
    ],
  });
  m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec() });
  return m;
}

describe('<CellsChart>', () => {
  it('registers its type’s modules with echarts.use and passes the option to setOption', async () => {
    const m = model();
    const div = await mount(<CellsChart model={m} id="c1" width={400} height={300} />);
    const figure = div.querySelector('[role="figure"]')!;
    expect(figure.getAttribute('aria-label')).toBe('Sales');
    expect(figure.getAttribute('aria-description')).toMatch(/North runs from 10 to 15/);
    expect(used).toHaveLength(1);
    expect(used[0]).toContain(BarChart);
    expect(used[0]).not.toContain(LineChart);
    expect(setOption).toHaveBeenCalled();
    const [option, how] = setOption.mock.calls[0];
    expect(option).toMatchObject({
      title: { text: 'Sales' },
      series: [{ type: 'bar', data: [10, 12, 15, 13] }],
    });
    expect(how).toMatchObject({ notMerge: true, lazyUpdate: true });
    // A second type's modules are registered once more, only the new ones.
    act(() => {
      m.dispatch({ type: 'UPDATE_CHART', sheet: 's1', id: 'c1', changes: { type: 'line' } });
    });
    expect(used).toHaveLength(2);
    expect(used[1]).toEqual([LineChart]);
  });

  it('rebuilds the option when a cell of its range changes, not on an edit elsewhere', async () => {
    const m = model();
    await mount(<CellsChart model={m} id="c1" />);
    const calls = setOption.mock.calls.length;
    act(() => {
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 20, col: 20 }, cells: [[1]] });
    });
    expect(setOption.mock.calls.length).toBe(calls);
    act(() => {
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [[99]] });
    });
    expect(setOption.mock.calls.length).toBe(calls + 1);
    expect(setOption.mock.calls.at(-1)![0].series[0].data).toEqual([99, 12, 15, 13]);
  });

  it('draws a labelled placeholder without the plugin', async () => {
    const m = model([]);
    const div = await mount(<CellsChart model={m} id="c1" />);
    expect(div.querySelector('[data-cells-chart-placeholder]')!.textContent).toBe(
      'A column chart: charts are not loaded',
    );
    expect(used).toHaveLength(0);
  });
});

describe('the grid’s chart layer', () => {
  it('places each chart in its pane’s clip, from the axes’ offsets, and draws it', async () => {
    const m = model();
    const div = await mount(
      <div style={{ width: 800, height: 400 }}>
        <Spreadsheet model={m} theme="auto" />
      </div>,
    );
    const pane = div.querySelector('[data-cells-charts-pane="main"]') as HTMLElement;
    expect(pane).not.toBeNull();
    expect(pane.style.overflow).toBe('hidden');
    const frame = pane.querySelector('[data-cells-chart="c1"]') as HTMLElement;
    expect(frame.getAttribute('role')).toBe('figure');
    const sheet = m.sheet('s1');
    const holder = frame.parentElement as HTMLElement;
    expect(holder.style.left).toBe(`${Math.round(sheet.cols.offsetOf(3))}px`);
    expect(holder.style.top).toBe(`${Math.round(sheet.rows.offsetOf(1))}px`);
    expect(holder.style.width).toBe(
      `${Math.round(sheet.cols.offsetOf(7) - sheet.cols.offsetOf(3))}px`,
    );
    expect(setOption).toHaveBeenCalled();
  });

  it('a frozen pane clips: a chart anchored in the frozen rows sits in the top pane', () => {
    const m = model();
    m.dispatch({ type: 'FREEZE', sheet: 's1', rows: 3, cols: 0 });
    const sheet = m.sheet('s1');
    const vp = computeViewport({
      rows: sheet.rows,
      cols: sheet.cols,
      frozen: { rows: 3, cols: 0 },
      width: 800,
      height: 400,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      showHeaders: true,
    });
    expect(paneOfChart(sheet, spec(), vp.panes).name).toBe('top');
    expect(
      paneOfChart(
        sheet,
        spec({
          anchor: {
            kind: 'cells',
            from: { row: 5, col: 1, dx: 0, dy: 0 },
            to: { row: 9, col: 4, dx: 0, dy: 0 },
          },
        }),
        vp.panes,
      ).name,
    ).toBe('main');
    expect(
      paneOfChart(
        sheet,
        spec({ anchor: { kind: 'absolute', x: 10, y: 10, width: 100, height: 50 } }),
        vp.panes,
      ).name,
    ).toBe('top');
  });

  it('mounts only charts within one viewport of the pane; the others keep their place', () => {
    const m = model();
    const sheet = m.sheet('s1');
    const vp = computeViewport({
      rows: sheet.rows,
      cols: sheet.cols,
      frozen: { rows: 0, cols: 0 },
      width: 800,
      height: 400,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      showHeaders: true,
    });
    const main = vp.panes.find((p) => p.name === 'main')!;
    expect(placeChart(sheet, spec(), main, 1).near).toBe(true);
    const far = spec({ anchor: { kind: 'absolute', x: 0, y: 5000, width: 300, height: 200 } });
    const placed = placeChart(sheet, far, main, 1);
    expect(placed.near).toBe(false);
    expect(placed.y).toBe(5000);
    const nearBelow = spec({
      anchor: { kind: 'absolute', x: 0, y: main.height + 100, width: 300, height: 200 },
    });
    expect(placeChart(sheet, nearBelow, main, 1).near).toBe(true);
    expect(placeChart(sheet, far, main, 2).width).toBe(600);
  });
});
