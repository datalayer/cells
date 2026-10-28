/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Data sources (C7-03): binding, paging on demand with `#BUSY!` meanwhile,
 * formulas settling once the pages arrive, eviction at the cap, failures as
 * `#N/A` with `onDataSourceError`, and the bound zone refused to every write.
 * Fetches resolve on fake timers.
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CellValue,
  CellsDataSources,
  createCellsModel,
  type DataSource,
  type DataSourceError,
  PAGE_ROWS,
  type Transaction,
} from '../index.js';

/** A synthetic source: `rowCount` rows of (id, name, amount), each page after `latency` ms; `failing` pages reject. */
function source(
  options: {
    id?: string;
    rowCount?: number;
    latency?: number;
    failing?: (from: number) => boolean;
    log?: { from: number; to: number }[];
  } = {},
): DataSource {
  const { id = 'orders', rowCount = 10_000, latency = 100, failing = () => false, log } = options;
  return {
    id,
    rowCount,
    columns: [{ name: 'id', type: 'number' }, { name: 'name' }, { name: 'amount', type: 'number' }],
    fetch: ({ from, to }) => {
      log?.push({ from, to });
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (failing(from)) reject(new Error(`rows ${from}–${to} are unreachable`));
          const n = to - from + 1;
          resolve([
            Array.from({ length: n }, (_, i) => from + i + 1),
            Array.from({ length: n }, (_, i) => `Order ${from + i + 1}`),
            Array.from({ length: n }, (_, i) => ((from + i) % 7) + 1),
          ]);
        }, latency);
      });
    },
  };
}

function plugin(name: string, ...sources: DataSource[]) {
  return definePlugin({
    name,
    contributes: sources.map((s) => contribution(CellsDataSources, s, { id: s.id })),
  });
}

const busy = (v: CellValue) => typeof v === 'object' && v !== null && v.error === '#BUSY!';
const na = (v: CellValue) => typeof v === 'object' && v !== null && v.error === '#N/A';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('binding a data source', () => {
  it('binds at a cell, with the source shape, carried in the file and undone as one step', () => {
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source())],
      limits: { rows: 20_000, cols: 10 },
    });
    expect(m.dataSourceIds()).toEqual(['orders']);
    expect(m.dataSourceOf('orders')?.plugin).toBe('@acme/orders');
    expect(m.dataSource('s1')).toBeUndefined();
    const r = m.dispatch({
      type: 'BIND_DATA_SOURCE',
      sheet: 's1',
      source: 'orders',
      at: { row: 1, col: 1 },
    });
    expect(r).toEqual({ ok: true });
    expect(m.dataSource('s1')).toMatchObject({
      binding: { id: 'orders', at: { row: 1, col: 1 }, rows: 10_000, cols: 3 },
      zone: { top: 1, left: 1, bottom: 10_000, right: 3 },
      source: { plugin: '@acme/orders' },
    });
    expect(m.toJSON().sheets[0].dataSource).toEqual({
      id: 'orders',
      row: 1,
      col: 1,
      rows: 10_000,
      cols: 3,
    });
    const again = createCellsModel({
      plugins: [plugin('@acme/orders', source())],
      data: m.toJSON(),
      limits: { rows: 20_000, cols: 10 },
    });
    expect(again.dataSource('s1')?.zone).toEqual({ top: 1, left: 1, bottom: 10_000, right: 3 });
    expect(m.undo()).toBe(true);
    expect(m.dataSource('s1')).toBeUndefined();
    expect(m.redo()).toBe(true);
    expect(m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: null })).toEqual({
      ok: true,
    });
    expect(m.toJSON().sheets[0].dataSource).toBeUndefined();
  });

  it('refuses an unknown source, a source that does not fit, cells underneath, a second binding, and a bad shape in the file', () => {
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source())],
      limits: { rows: 5_000, cols: 10 },
    });
    expect(m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'nope' })).toEqual({
      ok: false,
      refusals: [
        { reason: 'UnknownDataSource', message: "No plugin contributes the data source 'nope'." },
      ],
    });
    expect(m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders' })).toEqual({
      ok: false,
      refusals: [
        {
          reason: 'OutOfBounds',
          message:
            "The data source 'orders' has 10,000 rows and 3 columns: from A1 it reaches past the sheet's 5,000 rows and 10 columns.",
        },
      ],
    });
    const small = createCellsModel({
      plugins: [plugin('@acme/orders', source({ rowCount: 100 }))],
      limits: { rows: 500, cols: 10 },
    });
    small.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 5, col: 2 }, cells: [['taken']] });
    expect(
      small.dispatch({
        type: 'BIND_DATA_SOURCE',
        sheet: 's1',
        source: 'orders',
        at: { row: 1, col: 1 },
      }),
    ).toEqual({
      ok: false,
      refusals: [
        {
          reason: 'InvalidArgument',
          message: 'B2:D101 holds cells; a data source lands on empty cells.',
        },
      ],
    });
    expect(
      small.dispatch({
        type: 'BIND_DATA_SOURCE',
        sheet: 's1',
        source: 'orders',
        at: { row: 1, col: 4 },
      }),
    ).toEqual({ ok: true });
    expect(
      small.dispatch({
        type: 'BIND_DATA_SOURCE',
        sheet: 's1',
        source: 'orders',
        at: { row: 200, col: 4 },
      }),
    ).toEqual({
      ok: false,
      refusals: [
        {
          reason: 'InvalidArgument',
          message: "Sheet 'Sheet1' is bound to the data source 'orders' already; unbind it first.",
        },
      ],
    });
    expect(() =>
      createCellsModel({
        data: {
          version: 1,
          sheets: [
            {
              id: 'a',
              name: 'A',
              rows: {},
              dataSource: { id: 'x', row: 0, col: 0, rows: 0, cols: 1 },
            },
          ],
        },
      }),
    ).toThrow('sheets[0].dataSource.rows: at least 1');
    expect(() =>
      createCellsModel({
        data: {
          version: 1,
          sheets: [
            {
              id: 'a',
              name: 'A',
              rows: {},
              dataSource: { id: 'x', row: 0, col: 0, rows: 2_000_000, cols: 1 },
            },
          ],
        },
      }),
    ).toThrow('sheets[0].dataSource: reaches outside the sheet');
  });
});

describe('reading pages on demand', () => {
  it('shows #BUSY! until the page arrives, fetches each page once, and tells the view', async () => {
    const log: { from: number; to: number }[] = [];
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source({ log }))],
      limits: { rows: 20_000, cols: 10 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders', at: { row: 1, col: 1 } });
    const changes: Transaction[] = [];
    m.subscribe((tx) => changes.push(tx));
    // Row 2 is the source's row 0; row 1,500 of the sheet is source row 1,498: page 1.
    const first = m.value('s1', 1, 1);
    expect(busy(first)).toBe(true);
    expect((first as { message?: string }).message).toBe(
      "The data source 'orders' is reading rows 1–1,024.",
    );
    expect(busy(m.value('s1', 1, 2))).toBe(true); // the same page: no second fetch
    expect(busy(m.value('s1', 1_499, 3))).toBe(true);
    expect(log).toEqual([
      { from: 0, to: PAGE_ROWS - 1 },
      { from: PAGE_ROWS, to: 2 * PAGE_ROWS - 1 },
    ]);
    expect(m.dataSourceStats()).toMatchObject({ loading: 2, resident: 0, fetches: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(m.value('s1', 1, 1)).toBe(1);
    expect(m.value('s1', 1, 2)).toBe('Order 1');
    expect(m.value('s1', 1_499, 3)).toBe((1_498 % 7) + 1);
    expect(m.value('s1', 1_024, 1)).toBe(1_024); // the page's last row
    expect(m.value('s1', 1_025, 1)).toBe(1_025); // the next page's first
    expect(m.dataSourceStats()).toMatchObject({ loading: 0, resident: 2, fetches: 2 });
    expect(changes.map((tx) => tx.origin)).toEqual(['source', 'source']);
    // Outside the zone: plain empty cells; the last page clamps to the source's last row.
    expect(m.value('s1', 0, 1)).toBeNull();
    expect(m.value('s1', 10_001, 1)).toBeNull();
    expect(busy(m.value('s1', 10_000, 1))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(log[2]).toEqual({ from: 9 * PAGE_ROWS, to: 9_999 });
    expect(m.value('s1', 10_000, 1)).toBe(10_000);
    // The file never carries the rows that arrived.
    expect(Object.keys(m.toJSON().sheets[0].rows)).toEqual([]);
  });

  it('settles a SUM over source rows once its pages arrive, and a cell reference too', async () => {
    const log: { from: number; to: number }[] = [];
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source({ log }))],
      limits: { rows: 20_000, cols: 10 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders', at: { row: 1, col: 1 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 5 },
      cells: [
        [
          { formula: 'SUM(D2:D2049)' },
          { formula: 'B3*2' },
          { formula: 'COUNTA(C2:C2049)' },
          { formula: 'SUM(B1:B1)' },
        ],
      ],
    });
    expect(busy(m.value('s1', 0, 5))).toBe(true);
    expect(busy(m.value('s1', 0, 6))).toBe(true);
    expect(m.value('s1', 0, 8)).toBe(0); // above the zone: nothing to wait for
    expect(log.length).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    let expected = 0;
    for (let i = 0; i < 2_048; i += 1) expected += (i % 7) + 1;
    expect(m.value('s1', 0, 5)).toBe(expected);
    expect(m.value('s1', 0, 6)).toBe(4);
    expect(m.value('s1', 0, 7)).toBe(2_048);
    expect(log.length).toBe(2); // the formulas read what arrived; nothing fetched twice
  });

  it('refuses a range needing more pages than stay resident, with the sentence and no fetch', () => {
    const log: { from: number; to: number }[] = [];
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source({ rowCount: 10_000_000, log }))],
      limits: { rows: 10_000_010, cols: 10 },
      dataSources: { pages: 4 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders', at: { row: 1, col: 1 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 5 },
      cells: [[{ formula: 'SUM(D:D)' }]],
    });
    const v = m.value('s1', 0, 5);
    expect(na(v)).toBe(true);
    expect((v as { message?: string }).message).toBe(
      "Reading D1:D10000010 needs 9,766 pages of the data source 'orders'; 4 stay resident. Read a smaller range.",
    );
    expect(log).toEqual([]);
  });

  it('evicts the least recently read page at the cap, emptying its cells, and reads it again on demand', async () => {
    const log: { from: number; to: number }[] = [];
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source({ log }))],
      limits: { rows: 20_000, cols: 10 },
      dataSources: { pages: 2 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders', at: { row: 0, col: 0 } });
    m.value('s1', 0, 0); // page 0
    m.value('s1', 1_024, 0); // page 1
    await vi.advanceTimersByTimeAsync(100);
    expect(m.dataSourceStats()).toMatchObject({ resident: 2, evictions: 0 });
    m.value('s1', 0, 0); // page 0 read again: page 1 is now the least recent
    m.value('s1', 2_048, 0); // page 2
    await vi.advanceTimersByTimeAsync(100);
    expect(m.dataSourceStats()).toMatchObject({ resident: 2, evictions: 1, fetches: 3 });
    expect(m.value('s1', 0, 0)).toBe(1);
    expect(m.value('s1', 2_048, 0)).toBe(2_049);
    expect(m.sheet('s1').cells.isEmpty({ top: 1_024, left: 0, bottom: 2_047, right: 2 })).toBe(
      true,
    );
    expect(busy(m.value('s1', 1_024, 0))).toBe(true);
    expect(log.length).toBe(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(m.value('s1', 1_024, 0)).toBe(1_025);
    expect(m.dataSourceStats()).toMatchObject({ resident: 2, evictions: 2 });
  });

  it('shows #N/A with the sentence when a page fails, tells onDataSourceError, and reads again after a refresh', async () => {
    let fail = true;
    const log: { from: number; to: number }[] = [];
    const m = createCellsModel({
      plugins: [
        plugin('@acme/orders', source({ log, failing: (from) => fail && from === PAGE_ROWS })),
      ],
      limits: { rows: 20_000, cols: 10 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders', at: { row: 0, col: 0 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 5 },
      cells: [[{ formula: 'SUM(C1:C2048)' }]],
    });
    const errors: DataSourceError[] = [];
    m.subscribeDataSourceErrors((e) => errors.push(e));
    expect(busy(m.value('s1', 1_024, 0))).toBe(true);
    expect(busy(m.value('s1', 0, 5))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const v = m.value('s1', 1_024, 0);
    expect(na(v)).toBe(true);
    expect((v as { message?: string }).message).toBe(
      "The data source 'orders' failed for rows 1,025–2,048: rows 1024–2047 are unreachable",
    );
    expect(na(m.value('s1', 0, 5))).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      sheet: 's1',
      source: 'orders',
      rows: { from: 1_024, to: 2_047 },
    });
    expect(errors[0].error.message).toBe('rows 1024–2047 are unreachable');
    expect(m.dataSourceStats()).toMatchObject({ resident: 1, failed: 1 });
    // A failed page is not fetched again on its own.
    m.value('s1', 1_024, 0);
    expect(log.length).toBe(2);
    fail = false;
    m.refreshDataSource('s1');
    expect(m.dataSourceStats()).toMatchObject({ resident: 0, failed: 0 });
    expect(busy(m.value('s1', 1_024, 0))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(m.value('s1', 1_024, 0)).toBe(1_025);
    // The SUM read page 0 again too (emptied by the refresh): one more round trip.
    await vi.advanceTimersByTimeAsync(100);
    expect(typeof m.value('s1', 0, 5)).toBe('number');
  });

  it('refuses a page of the wrong shape as a failure', async () => {
    const bad: DataSource = {
      id: 'bad',
      rowCount: 10,
      columns: [{ name: 'a' }, { name: 'b' }],
      fetch: () => Promise.resolve([[1, 2, 3]]),
    };
    const m = createCellsModel({
      plugins: [plugin('@acme/bad', bad)],
      limits: { rows: 100, cols: 10 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'bad' });
    const errors: DataSourceError[] = [];
    m.subscribeDataSourceErrors((e) => errors.push(e));
    m.value('s1', 0, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0]?.error.message).toBe(
      "the data source 'bad' answered 1 columns for rows 1–10, not 2 columns of 10 rows.",
    );
    expect(na(m.value('s1', 0, 0))).toBe(true);
  });

  it('shows #N/A naming the plugin when its source is gone, and reads again when it is back or the shape differs', async () => {
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source())],
      limits: { rows: 20_000, cols: 10 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders' });
    m.value('s1', 0, 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(m.value('s1', 0, 0)).toBe(1);
    const changes: Transaction[] = [];
    m.subscribe((tx) => changes.push(tx));
    m.reactor.disable('@acme/orders');
    const v = m.value('s1', 0, 0);
    expect(na(v)).toBe(true);
    expect((v as { message?: string }).message).toBe(
      "No plugin contributes the data source 'orders'.",
    );
    expect(m.dataSource('s1')?.source).toBeUndefined();
    expect(m.dataSourceStats()).toMatchObject({ resident: 0 });
    expect(changes.map((tx) => tx.origin)).toContain('plugins');
    m.reactor.enable('@acme/orders');
    expect(busy(m.value('s1', 0, 0))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(m.value('s1', 0, 0)).toBe(1);
    // The same id with another shape: refused, said in the cells.
    const other = createCellsModel({
      plugins: [plugin('@acme/orders', source({ rowCount: 50 }))],
      data: m.toJSON(),
      limits: { rows: 20_000, cols: 10 },
    });
    const w = other.value('s1', 0, 0);
    expect(na(w)).toBe(true);
    expect((w as { message?: string }).message).toBe(
      "The data source 'orders' has 50 rows and 3 columns; the sheet binds 10,000 rows and 3 columns. Bind it again.",
    );
  });
});

describe('the bound zone is read-only', () => {
  function bound() {
    const m = createCellsModel({
      plugins: [plugin('@acme/orders', source({ rowCount: 100 }))],
      limits: { rows: 500, cols: 10 },
    });
    m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'orders', at: { row: 2, col: 1 } });
    return m;
  }
  const readOnly = (what = '') => ({
    ok: false,
    refusals: [
      {
        reason: 'ReadOnly',
        message: `B3:D102 shows the data source 'orders' and cannot be changed${what}.`,
      },
    ],
  });

  it('refuses cells, styles, clears, merges, fills and pastes reaching into it', async () => {
    const m = bound();
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 5, col: 2 }, cells: [['x']] }),
    ).toEqual(readOnly());
    expect(
      m.dispatch({
        type: 'SET_CELLS',
        sheet: 's1',
        at: { row: 1, col: 0 },
        cells: [
          ['ok', 'ok'],
          ['ok', 'no'],
        ],
      }),
    ).toEqual(readOnly());
    expect(
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 2, left: 1, bottom: 2, right: 1 },
        style: { bold: true },
      }),
    ).toEqual(readOnly());
    expect(
      m.dispatch({ type: 'CLEAR', sheet: 's1', zone: { top: 0, left: 0, bottom: 200, right: 9 } }),
    ).toEqual(readOnly());
    expect(
      m.dispatch({ type: 'MERGE', sheet: 's1', zone: { top: 1, left: 1, bottom: 3, right: 1 } }),
    ).toEqual(readOnly(': no merge over it'));
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 1 }, cells: [[1, 2, 3]] });
    m.select({
      sheet: 's1',
      zones: [{ top: 0, left: 1, bottom: 0, right: 3 }],
      anchor: { row: 0, col: 1 },
      active: { row: 0, col: 1 },
    });
    expect(
      m.dispatch({
        type: 'FILL',
        sheet: 's1',
        source: { top: 0, left: 1, bottom: 0, right: 3 },
        target: { top: 0, left: 1, bottom: 4, right: 3 },
      }),
    ).toEqual(readOnly());
    const slice = m.copy({ top: 0, left: 1, bottom: 0, right: 3 });
    expect(m.paste(slice, { row: 2, col: 1 })).toEqual(readOnly());
    // The cells around it take edits as ever.
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [['header']] }),
    ).toEqual({ ok: true });
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 4 }, cells: [['beside']] }),
    ).toEqual({ ok: true });
    expect(() => m.loadColumns('s1', { row: 2, col: 3 }, [[1, 2]])).toThrow(
      "D3:D4 reaches B3:D102, which shows the data source 'orders' and cannot be loaded into.",
    );
    expect(m.edit).toBeNull();
    m.startEdit({ row: 5, col: 2 });
    await vi.advanceTimersByTimeAsync(100);
    m.setEditText('typed');
    expect(m.commitEdit()).toEqual(readOnly());
  });

  it('refuses rows and columns inserted, deleted or moved inside it; above or left, the anchor and the pages follow, with undo', async () => {
    const m = bound();
    m.value('s1', 2, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(m.value('s1', 2, 2)).toBe('Order 1');
    expect(m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 10, n: 2 })).toEqual(
      readOnly(': no rows inserted inside it'),
    );
    expect(m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 100, n: 5 })).toEqual(
      readOnly(': no rows deleted from it'),
    );
    expect(m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'cols', at: 2, n: 1 })).toEqual(
      readOnly(': no cols deleted from it'),
    );
    expect(
      m.dispatch({ type: 'MOVE_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1, to: 50 }),
    ).toEqual(readOnly(': no rows moved into or out of it'));
    expect(m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 2, n: 1 })).toEqual({
      ok: true,
    }); // at the zone's first row: above it
    expect(m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'cols', at: 0, n: 2 })).toEqual({
      ok: true,
    });
    expect(m.dataSource('s1')?.zone).toEqual({ top: 3, left: 3, bottom: 102, right: 5 });
    // The resident page moved with its rows and columns: no fetch again.
    expect(m.value('s1', 3, 4)).toBe('Order 1');
    expect(m.dataSourceStats()).toMatchObject({ fetches: 1, resident: 1 });
    expect(m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2 })).toEqual({
      ok: true,
    });
    expect(m.dataSource('s1')?.zone).toEqual({ top: 1, left: 3, bottom: 100, right: 5 });
    expect(m.value('s1', 1, 4)).toBe('Order 1');
    m.undo();
    m.undo();
    m.undo();
    expect(m.dataSource('s1')?.zone).toEqual({ top: 2, left: 1, bottom: 101, right: 3 });
    expect(m.value('s1', 2, 2)).toBe('Order 1');
    expect(m.toJSON().sheets[0].dataSource).toEqual({
      id: 'orders',
      row: 2,
      col: 1,
      rows: 100,
      cols: 3,
    });
  });

  it('unbinding empties the pages and frees the zone', async () => {
    const m = bound();
    m.value('s1', 2, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(m.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: null })).toEqual({
      ok: true,
    });
    expect(m.sheet('s1').cells.isEmpty({ top: 2, left: 1, bottom: 101, right: 3 })).toBe(true);
    expect(m.value('s1', 2, 1)).toBeNull();
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 5, col: 2 }, cells: [['x']] }),
    ).toEqual({ ok: true });
    m.undo();
    expect(m.undo()).toBe(true);
    expect(busy(m.value('s1', 2, 1))).toBe(true);
  });
});
