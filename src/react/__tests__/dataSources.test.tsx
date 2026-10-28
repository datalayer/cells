/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * Data sources from React (C7-03): `useDataSource` reads the binding, the
 * page counters and the last failure, binds and unbinds; `onDataSourceError`
 * on the grid hears a failed page; the mirror names a waiting cell.
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { act, version as reactVersion } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CellsDataSources,
  CellsProvider,
  createCellsModel,
  type DataSource,
  type DataSourceError,
  Spreadsheet,
  useDataSource,
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
});

function mount(node: React.ReactNode): HTMLDivElement {
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(node));
  return div;
}

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function orders(failing = false): DataSource {
  return {
    id: 'orders',
    rowCount: 50,
    columns: [{ name: 'id' }, { name: 'amount' }],
    fetch: ({ from, to }) =>
      failing
        ? Promise.reject(new Error('the server is away'))
        : Promise.resolve([
            Array.from({ length: to - from + 1 }, (_, i) => from + i + 1),
            Array.from({ length: to - from + 1 }, (_, i) => (from + i) * 10),
          ]),
  };
}
const plugin = (source: DataSource) =>
  definePlugin({
    name: '@acme/orders',
    contributes: [contribution(CellsDataSources, source, { id: source.id })],
  });

function Panel() {
  const { source, stats, lastError, bind, unbind } = useDataSource();
  return (
    <div>
      <output data-source="">
        {source === undefined
          ? 'unbound'
          : `${source.binding.id} from ${source.source?.plugin ?? source.problem}`}
      </output>
      <output data-stats="">{`${stats.resident} resident, ${stats.failed} failed, ${stats.loading} loading`}</output>
      <output data-error="">{lastError?.error.message ?? ''}</output>
      <button onClick={() => bind('orders', { row: 1, col: 1 })}>Bind</button>
      <button onClick={unbind}>Unbind</button>
    </div>
  );
}

describe(`data sources from React (React ${reactVersion})`, () => {
  it('binds and unbinds from the hook, reads the binding and the counters as pages arrive', async () => {
    const m = createCellsModel({ plugins: [plugin(orders())], limits: { rows: 100, cols: 10 } });
    const div = mount(
      <CellsProvider model={m}>
        <Spreadsheet model={m} />
        <Panel />
      </CellsProvider>,
    );
    const text = (sel: string) => div.querySelector(sel)!.textContent;
    expect(text('[data-source]')).toBe('unbound');
    act(() => div.querySelector<HTMLButtonElement>('button')!.click());
    expect(text('[data-source]')).toBe('orders from @acme/orders');
    // The grid read the page for its viewport: one page loading, then resident.
    await tick();
    expect(text('[data-stats]')).toBe('1 resident, 0 failed, 0 loading');
    expect([...div.querySelectorAll('[role="gridcell"]')].map((c) => c.textContent)).toContain(
      '10',
    );
    act(() => div.querySelectorAll<HTMLButtonElement>('button')[1].click());
    expect(text('[data-source]')).toBe('unbound');
    expect(text('[data-stats]')).toBe('0 resident, 0 failed, 0 loading');
  });

  it('tells onDataSourceError and the hook when a page fails, and names the cell #N/A', async () => {
    const m = createCellsModel({
      plugins: [plugin(orders(true))],
      limits: { rows: 100, cols: 10 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders', at: { row: 1, col: 1 } });
    const errors: DataSourceError[] = [];
    const div = mount(
      <CellsProvider model={m}>
        <Spreadsheet model={m} onDataSourceError={(e) => errors.push(e)} />
        <Panel />
      </CellsProvider>,
    );
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ sheet: 's1', source: 'orders', rows: { from: 0, to: 49 } });
    expect(div.querySelector('[data-error]')!.textContent).toBe('the server is away');
    expect(div.querySelector('[data-stats]')!.textContent).toBe('0 resident, 1 failed, 0 loading');
    expect([...div.querySelectorAll('[role="gridcell"]')].map((c) => c.textContent)).toContain(
      '#N/A, not available',
    );
  });
});
