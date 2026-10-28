/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C10-02: charts follow the dependency graph. A chart's ranges are nodes of
 * the R-tree; a pass marks the charts it dirtied, and they settle once, at
 * the end of the slice their cells settled in; `chartData` reads the values.
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { describe, expect, it } from 'vitest';
import {
  type CellInput,
  CellsFunctions,
  type ChartSpec,
  chartData,
  chartRanges,
  createCellsModel,
  type Transaction,
} from '../index.js';

const SALES: CellInput[][] = [
  ['Month', 'North', 'South'],
  ['Jan', 10, 7],
  ['Feb', 12, 9],
  ['Mar', 15, 11],
  ['Apr', 13, 14],
];

function model(rows: CellInput[][] = SALES, plugins: unknown[] = []) {
  const m = createCellsModel({ limits: { rows: 300_000, cols: 20 }, plugins: plugins as never });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: rows });
  return m;
}

const chart = (
  id: string,
  values: string,
  over: Partial<ChartSpec> = {},
): Omit<ChartSpec, 'id'> & { id: string } => ({
  id,
  type: 'column',
  anchor: {
    kind: 'cells',
    from: { row: 1, col: 5, dx: 0, dy: 0 },
    to: { row: 12, col: 10, dx: 0, dy: 0 },
  },
  data: {
    series: [{ name: 'Sheet1!$B$1', values, categories: 'Sheet1!$A$2:$A$5' }],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: 'gap',
  },
  legend: 'bottom',
  ...over,
});

/** The charts each transaction announced, flattened in order. */
function recorder(m: ReturnType<typeof model>) {
  const settled: { origin: string; charts: string[]; calculating: boolean }[] = [];
  m.subscribe((tx: Transaction) => {
    if (tx.charts !== undefined)
      settled.push({
        origin: tx.origin,
        charts: tx.charts.map((c) => c.id),
        calculating: m.stats().engine.calculating,
      });
  });
  return settled;
}

const idle = (m: ReturnType<typeof model>) =>
  expect.poll(() => m.stats().engine.calculating, { timeout: 20_000, interval: 5 }).toBe(false);

describe('charts in the graph', () => {
  it('an edit inside a chart’s range marks exactly the charts reading it; outside, none', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart('north', 'Sheet1!$B$2:$B$5') });
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart('south', 'Sheet1!$C$2:$C$5') });
    expect(m.chartRevision('s1', 'north')).toBe(1); // settled with its insert
    const settled = recorder(m);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 1 }, cells: [[99]] });
    expect(settled).toEqual([{ origin: 'local', charts: ['north'], calculating: false }]);
    expect(m.chartRevision('s1', 'north')).toBe(2);
    expect(m.chartRevision('s1', 'south')).toBe(1);
    // A category cell is read too (both charts share the categories).
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 0 }, cells: [['Février']] });
    expect(settled[1].charts.sort()).toEqual(['north', 'south']);
    // Outside every range: nothing.
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 8, col: 8 }, cells: [[1]] });
    expect(settled).toHaveLength(2);
    expect(m.chartRevision('s1', 'north')).toBe(3);
    // A formula outside the range reading a cell inside marks nothing either: the chart reads cells, not readers.
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 9, col: 9 },
      cells: [[{ formula: 'B3*2' }]],
    });
    expect(settled).toHaveLength(2);
  });

  it('a formula inside the range marks the chart when its precedent changes; it settles with the slice', async () => {
    const m = model();
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 4, col: 1 },
      cells: [[{ formula: 'B2+B3' }]],
    });
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart('north', 'Sheet1!$B$2:$B$5') });
    const settled = recorder(m);
    expect(m.value('s1', 4, 1)).toBe(22);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [[20]] });
    // B5 waits for the background: the chart is marked, not rebuilt, until it settles.
    expect(settled).toEqual([]);
    expect(m.chartsPending()).toEqual([{ sheet: 's1', id: 'north' }]);
    await idle(m);
    expect(settled).toEqual([{ origin: 'charts', charts: ['north'], calculating: false }]);
    expect(m.chartData('s1', 'north').series[0].values).toEqual([20, 12, 15, 32]);
  });

  it('a chart deleted while marked, or deleted at all, announces nothing and loses its revision', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart('north', 'Sheet1!$B$2:$B$5') });
    const settled = recorder(m);
    m.dispatch({ type: 'DELETE_CHART', sheet: 's1', id: 'north' });
    expect(settled).toEqual([]);
    expect(m.chartRevision('s1', 'north')).toBe(0);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 1 }, cells: [[99]] });
    expect(settled).toEqual([]);
    m.undo(); // the edit
    m.undo(); // the chart is back, registered again
    expect(m.chartRevision('s1', 'north')).toBe(1);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 1 }, cells: [[98]] });
    expect(settled.at(-1)).toMatchObject({ origin: 'local', charts: ['north'] });
  });

  it('an update that moves the ranges reads the new ones, not the old', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart('c', 'Sheet1!$B$2:$B$5') });
    const settled = recorder(m);
    m.dispatch({
      type: 'UPDATE_CHART',
      sheet: 's1',
      id: 'c',
      changes: { data: { ...chart('c', 'Sheet1!$C$2:$C$5').data } },
    });
    expect(settled.map((s) => s.charts)).toEqual([['c']]);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 1 }, cells: [[99]] });
    expect(settled).toHaveLength(1); // column B is no longer read
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 2 }, cells: [[99]] });
    expect(settled).toHaveLength(2);
  });

  it('rows inserted above the range: the chart reads its moved range and its revision moves', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart('c', 'Sheet1!$B$2:$B$5') });
    const before = m.chartRevision('s1', 'c');
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2 });
    expect(m.sheet('s1').charts.get('c')!.data.series[0].values).toBe('Sheet1!$B$4:$B$7');
    expect(m.chartRevision('s1', 'c')).toBeGreaterThan(before);
    expect(m.chartData('s1', 'c').series[0].values).toEqual([10, 12, 15, 13]);
    const settled = recorder(m);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 4, col: 1 }, cells: [[1]] });
    expect(settled.map((s) => s.charts)).toEqual([['c']]);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [[1]] });
    expect(settled).toHaveLength(1); // the old position reads nothing
  });

  it('the head of a 100,000-long chain feeding a chart rebuilds it once, after the pass, never mid-slice', async () => {
    const m = model([[1]]);
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [[{ formula: 'A1+1' }]],
    });
    m.dispatch({
      type: 'FILL',
      sheet: 's1',
      source: { top: 1, left: 0, bottom: 1, right: 0 },
      target: { top: 1, left: 0, bottom: 99_999, right: 0 },
    });
    expect(m.value('s1', 99_999, 0)).toBe(100_000);
    await idle(m);
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: chart('tail', 'Sheet1!$A$99990:$A$100000', {
        data: {
          series: [{ values: 'Sheet1!$A$99990:$A$100000' }],
          by: 'columns',
          headers: { row: false, column: false },
          blanks: 'gap',
        },
      }),
    });
    await idle(m);
    const settled = recorder(m);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[2]] });
    expect(m.stats().engine.calculating).toBe(true);
    expect(settled).toEqual([]); // marked, not rebuilt: its cells are still waiting
    expect(m.chartsPending()).toEqual([{ sheet: 's1', id: 'tail' }]);
    await idle(m);
    expect(settled).toEqual([{ origin: 'charts', charts: ['tail'], calculating: false }]);
    expect(m.chartsPending()).toEqual([]);
    expect(m.chartData('s1', 'tail').series[0].values[10]).toBe(100_001);
  });

  it('a #BUSY! cell is a gap, then its value', async () => {
    const resolvers: (() => void)[] = [];
    const Slow = definePlugin({
      name: '@acme/slow',
      contributes: [
        contribution(CellsFunctions, {
          name: 'SLOW',
          args: [{ name: 'x', type: 'scalar' }],
          returns: 'number',
          category: 'other',
          async: true,
          compute: ([x]) =>
            new Promise<number>((resolve) => resolvers.push(() => resolve((x as number) * 10))),
          description: 'Ten times a number, later.',
          examples: ['=SLOW(2) → 20'],
        }),
      ],
    });
    const m = model(
      [
        ['Month', 'North'],
        ['Jan', 10],
        ['Feb', { formula: 'SLOW(B2)' }],
        ['Mar', 15],
        ['Apr', 13],
      ],
      [Slow],
    );
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart('c', 'Sheet1!$B$2:$B$5') });
    expect(m.chartData('s1', 'c').series[0].values).toEqual([10, null, 15, 13]);
    const settled = recorder(m);
    await expect.poll(() => resolvers.length).toBe(1); // compute runs on a microtask
    resolvers.shift()!();
    await idle(m);
    await expect.poll(() => settled.length).toBe(1);
    expect(settled[0]).toMatchObject({ origin: 'charts', charts: ['c'] });
    expect(m.chartData('s1', 'c').series[0].values).toEqual([10, 100, 15, 13]);
  });
});

describe('chartRanges and chartData', () => {
  it('chartRanges resolves every reference, a #REF! one reading nothing', () => {
    const m = model();
    const spec = { ...chart('c', 'Sheet1!$B$2:$B$5'), id: 'c' } as ChartSpec;
    expect(chartRanges(m.workbook, 's1', spec)).toEqual([
      { sheet: 's1', zone: { top: 1, left: 1, bottom: 4, right: 1 } },
      { sheet: 's1', zone: { top: 1, left: 0, bottom: 4, right: 0 } },
      { sheet: 's1', zone: { top: 0, left: 1, bottom: 0, right: 1 } },
    ]);
    const gone = { ...spec, data: { ...spec.data, series: [{ values: '#REF!', name: 'Fixed' }] } };
    expect(chartRanges(m.workbook, 's1', gone)).toEqual([]);
  });

  it('chartData: numbers in reading order, gaps for text, booleans, errors and blanks (or 0), names from cells or text, categories, deleted ranges', () => {
    const m = model([
      ['Month', 'North', 'South'],
      ['Jan', 10, 'n/a'],
      ['Feb', true, 9],
      ['Mar', null, { formula: '1/0' }],
      ['Apr', 13, 14],
    ]);
    const read = (s: string, r: number, c: number) => m.value(s, r, c);
    const spec = {
      ...chart('c', 'Sheet1!$B$2:$B$5'),
      data: {
        series: [
          { name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$5', categories: 'Sheet1!$A$2:$A$5' },
          { name: 'Southern', values: 'Sheet1!$C$2:$C$5', color: '#123456', axis: 'secondary' },
          { values: 'Sheet1!$B$2:$C$3' },
        ],
        by: 'columns',
        headers: { row: true, column: true },
        blanks: 'gap',
      },
    } as ChartSpec;
    const d = chartData(read, m.workbook, 's1', spec);
    expect(d.categories).toEqual(['Jan', 'Feb', 'Mar', 'Apr']);
    expect(d.series.map((s) => s.name)).toEqual(['North', 'Southern', 'Series 3']);
    expect(d.series[0].values).toEqual([10, null, null, 13]);
    expect(d.series[1]).toMatchObject({
      values: [null, 9, null, 14],
      color: '#123456',
      axis: 'secondary',
      source: 'Sheet1!$C$2:$C$5',
    });
    expect(d.series[2].values).toEqual([10, null, null, 9]); // a rectangle, row by row
    expect(d.deleted).toEqual([]);
    const zero = chartData(read, m.workbook, 's1', {
      ...spec,
      data: { ...spec.data, blanks: 'zero' },
    });
    expect(zero.series[0].values).toEqual([10, null, 0, 13]);
    const gone = chartData(read, m.workbook, 's1', {
      ...spec,
      data: {
        ...spec.data,
        series: [{ values: '#REF!', categories: '#REF!', name: 'Sheet1!$B$1' }],
      },
    });
    expect(gone.series[0]).toEqual({ name: 'North', values: [] });
    expect(gone.deleted).toEqual(['#REF!']);
  });

  it('chartData reads another sheet, and a scatter’s x', () => {
    const m = model();
    m.dispatch({ type: 'ADD_SHEET', name: 'Data' });
    const data = m.sheets[1].id;
    m.dispatch({
      type: 'SET_CELLS',
      sheet: data,
      at: { row: 0, col: 0 },
      cells: [
        [1, 2],
        [2, 4],
        [3, 8],
      ],
    });
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: chart('x', 'Data!$B$1:$B$3', {
        type: 'scatter',
        data: {
          series: [{ values: 'Data!$B$1:$B$3', x: 'Data!$A$1:$A$3' }],
          by: 'columns',
          headers: { row: false, column: false },
          blanks: 'gap',
        },
      }),
    });
    expect(m.chartData('s1', 'x').series[0]).toMatchObject({ values: [2, 4, 8], x: [1, 2, 3] });
    const settled = recorder(m);
    m.dispatch({ type: 'SET_CELLS', sheet: data, at: { row: 0, col: 0 }, cells: [[0]] });
    expect(settled.map((s) => s.charts)).toEqual([['x']]);
  });
});
