/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CellInput,
  type ChartSpec,
  createCellsModel,
  inferChartData,
  MAX_CHART_POINTS,
  validateWorkbook,
} from '../index.js';

const corpus = JSON.parse(
  readFileSync(new URL('../../../tests/format/charts-malformed.json', import.meta.url), 'utf8'),
) as { good: ChartSpec; cases: { name: string; path: string; chart: unknown }[] };

function model(rows: CellInput[][] = SALES) {
  const m = createCellsModel({ limits: { rows: 300_000, cols: 20 } });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: rows });
  return m;
}

const SALES: CellInput[][] = [
  ['Month', 'North', 'South'],
  ['Jan', 10, 7],
  ['Feb', 12, 9],
  ['Mar', 15, 11],
  ['Apr', 13, 14],
];

const chart = (over: Partial<ChartSpec> = {}): Omit<ChartSpec, 'id'> & { id?: string } => ({
  type: 'column',
  anchor: {
    kind: 'cells',
    from: { row: 1, col: 5, dx: 0, dy: 0 },
    to: { row: 12, col: 10, dx: 0, dy: 0 },
  },
  data: {
    series: [{ name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$5', categories: 'Sheet1!$A$2:$A$5' }],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: 'gap',
  },
  legend: 'bottom',
  ...over,
});

const reasons = (r: { ok: boolean; refusals?: readonly { reason: string }[] }) =>
  r.ok ? 'ok' : r.refusals!.map((x) => x.reason).join(',');

describe('the chart commands', () => {
  it('INSERT_CHART: inserts, with an id made when none is given; refuses a duplicate, a bad spec, no number, too many points', () => {
    const m = model();
    expect(m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart() })).toEqual({ ok: true });
    expect([...m.sheet('s1').charts.keys()]).toEqual(['chart1']);
    expect(
      reasons(m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart({ id: 'chart1' }) })),
    ).toBe('DuplicateChart');
    expect(
      reasons(
        m.dispatch({
          type: 'INSERT_CHART',
          sheet: 's1',
          chart: chart({ legend: 'middle' as never }),
        }),
      ),
    ).toBe('InvalidArgument');
    expect(
      reasons(
        m.dispatch({
          type: 'INSERT_CHART',
          sheet: 's1',
          chart: chart({ data: { ...chart().data, series: [{ values: 'Sheet1!$A$2:$A$5' }] } }),
        }),
      ),
    ).toBe('NoNumericData');
    expect(
      reasons(
        m.dispatch({
          type: 'INSERT_CHART',
          sheet: 's1',
          chart: chart({
            data: { ...chart().data, series: [{ values: 'Sheet1!$B$1:$B$200000' }] },
          }),
        }),
      ),
    ).toBe('ChartTooLarge');
    expect(reasons(m.dispatch({ type: 'INSERT_CHART', sheet: 'nope', chart: chart() }))).toBe(
      'UnknownSheet',
    );
    m.undo();
    expect(m.sheet('s1').charts.size).toBe(0);
  });

  it('UPDATE_CHART: changes fields; refuses the id, the anchor, a bad field and an unknown chart', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart({ id: 'c' }) });
    expect(
      m.dispatch({
        type: 'UPDATE_CHART',
        sheet: 's1',
        id: 'c',
        changes: { type: 'line', title: 'Sales' },
      }),
    ).toEqual({ ok: true });
    expect(m.sheet('s1').charts.get('c')).toMatchObject({ type: 'line', title: 'Sales' });
    expect(
      reasons(
        m.dispatch({
          type: 'UPDATE_CHART',
          sheet: 's1',
          id: 'c',
          changes: { anchor: chart().anchor } as never,
        }),
      ),
    ).toBe('InvalidArgument');
    expect(
      reasons(
        m.dispatch({
          type: 'UPDATE_CHART',
          sheet: 's1',
          id: 'c',
          changes: { variant: 'exploded' as never },
        }),
      ),
    ).toBe('InvalidArgument');
    expect(reasons(m.dispatch({ type: 'UPDATE_CHART', sheet: 's1', id: 'x', changes: {} }))).toBe(
      'UnknownChart',
    );
    m.undo();
    expect(m.sheet('s1').charts.get('c')?.type).toBe('column');
  });

  it('MOVE_CHART and RESIZE_CHART: by cells, or px for absolute charts; refuse the wrong kind and off the sheet', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart({ id: 'c' }) });
    expect(
      m.dispatch({ type: 'MOVE_CHART', sheet: 's1', id: 'c', to: { row: 20, col: 2 } }),
    ).toEqual({ ok: true });
    expect(m.sheet('s1').charts.get('c')!.anchor).toMatchObject({
      from: { row: 20, col: 2 },
      to: { row: 31, col: 7 },
    });
    expect(
      m.dispatch({ type: 'RESIZE_CHART', sheet: 's1', id: 'c', to: { row: 40, col: 9 } }),
    ).toEqual({ ok: true });
    expect(m.sheet('s1').charts.get('c')!.anchor).toMatchObject({ to: { row: 40, col: 9 } });
    expect(
      reasons(m.dispatch({ type: 'MOVE_CHART', sheet: 's1', id: 'c', to: { x: 4, y: 4 } })),
    ).toBe('InvalidArgument');
    expect(
      reasons(m.dispatch({ type: 'RESIZE_CHART', sheet: 's1', id: 'c', to: { row: 10, col: 1 } })),
    ).toBe('InvalidArgument');
    expect(
      reasons(
        m.dispatch({ type: 'MOVE_CHART', sheet: 's1', id: 'c', to: { row: 299_995, col: 2 } }),
      ),
    ).toBe('InvalidArgument');
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: chart({
        id: 'a',
        anchor: { kind: 'absolute', x: 10, y: 10, width: 300, height: 200 },
      }),
    });
    expect(m.dispatch({ type: 'MOVE_CHART', sheet: 's1', id: 'a', to: { x: 40, y: 50 } })).toEqual({
      ok: true,
    });
    expect(
      m.dispatch({ type: 'RESIZE_CHART', sheet: 's1', id: 'a', to: { width: 500, height: 250 } }),
    ).toEqual({ ok: true });
    expect(m.sheet('s1').charts.get('a')!.anchor).toEqual({
      kind: 'absolute',
      x: 40,
      y: 50,
      width: 500,
      height: 250,
    });
    expect(
      reasons(
        m.dispatch({ type: 'RESIZE_CHART', sheet: 's1', id: 'a', to: { width: 0, height: 9 } }),
      ),
    ).toBe('InvalidArgument');
  });

  it('DELETE_CHART: deletes, undo brings it back; refuses an unknown chart', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart({ id: 'c' }) });
    const before = m.sheet('s1').charts.get('c');
    expect(m.dispatch({ type: 'DELETE_CHART', sheet: 's1', id: 'c' })).toEqual({ ok: true });
    expect(m.sheet('s1').charts.has('c')).toBe(false);
    expect(reasons(m.dispatch({ type: 'DELETE_CHART', sheet: 's1', id: 'c' }))).toBe(
      'UnknownChart',
    );
    m.undo();
    expect(m.sheet('s1').charts.get('c')).toEqual(before);
  });
});

describe('charts follow rows and columns', () => {
  it('ranges and anchors move on inserts, shrink and turn #REF! on deletes, follow moves; undo restores', () => {
    const m = model();
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart({ id: 'c' }) });
    const original = m.sheet('s1').charts.get('c');
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2 });
    let c = m.sheet('s1').charts.get('c')!;
    expect(c.data.series[0]).toEqual({
      name: 'Sheet1!$B$3',
      values: 'Sheet1!$B$4:$B$7',
      categories: 'Sheet1!$A$4:$A$7',
    });
    expect(c.anchor).toMatchObject({ from: { row: 3 }, to: { row: 14 } });
    m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 4, n: 2 });
    c = m.sheet('s1').charts.get('c')!;
    expect(c.data.series[0].values).toBe('Sheet1!$B$4:$B$5');
    m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'cols', at: 1, n: 1 });
    c = m.sheet('s1').charts.get('c')!;
    expect(c.data.series[0].values).toBe('#REF!');
    expect(c.anchor).toMatchObject({ from: { col: 4 }, to: { col: 9 } });
    m.undo();
    m.undo();
    m.undo();
    expect(m.sheet('s1').charts.get('c')).toEqual(original);
  });

  it('an anchor whose rows are all deleted collapses onto the next row kept', () => {
    const m = model();
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: chart({
        id: 'c',
        anchor: {
          kind: 'cells',
          from: { row: 20, col: 1, dx: 4, dy: 4 },
          to: { row: 25, col: 4, dx: 0, dy: 0 },
        },
      }),
    });
    m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 18, n: 10 });
    expect(m.sheet('s1').charts.get('c')!.anchor).toMatchObject({
      from: { row: 18 },
      to: { row: 18 },
    });
  });

  it('a sheet deleted takes its charts; undo brings both back', () => {
    const m = model();
    m.dispatch({ type: 'ADD_SHEET', name: 'Two' });
    const two = m.sheets[1].id;
    m.dispatch({ type: 'SET_CELLS', sheet: two, at: { row: 0, col: 0 }, cells: [[1], [2]] });
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: two,
      chart: chart({ id: 'c', data: { ...chart().data, series: [{ values: 'Two!A1:A2' }] } }),
    });
    m.dispatch({ type: 'DELETE_SHEET', sheet: two });
    m.undo();
    expect(m.sheet(two).charts.has('c')).toBe(true);
  });
});

describe('charts in the CellsWorkbook format', () => {
  it('round-trips through toJSON and a load', () => {
    const m = model();
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: chart({
        id: 'c',
        title: 'Sales',
        axes: { y: { min: 0, gridlines: true } },
        labels: true,
      }),
    });
    const json = m.toJSON();
    expect(json.sheets[0].charts?.c).toEqual(m.sheet('s1').charts.get('c'));
    const again = createCellsModel({ limits: { rows: 300_000, cols: 20 }, data: json });
    expect(again.sheet('s1').charts.get('c')).toEqual(m.sheet('s1').charts.get('c'));
  });

  it.each(corpus.cases.map((c) => [c.name, c] as const))(
    'refuses %s with the path of the field',
    (_, c) => {
      const data = {
        version: 1,
        sheets: [{ id: 's1', name: 'Sheet1', rows: {}, charts: { c1: c.chart } }],
      };
      expect(() => validateWorkbook(data)).toThrow(c.path);
      // The corpus's good chart is accepted: each case breaks one field only.
      expect(() =>
        validateWorkbook({
          version: 1,
          sheets: [{ id: 's1', name: 'Sheet1', rows: {}, charts: { c1: corpus.good } }],
        }),
      ).not.toThrow();
    },
  );
});

describe('inference from a selection', () => {
  const grid = (rows: unknown[][]) => (r: number, c: number) => (rows[r]?.[c] ?? null) as never;
  const zone = (bottom: number, right: number) => ({ top: 0, left: 0, bottom, right });
  const cases: [string, unknown[][], Record<string, unknown>][] = [
    [
      'headers on both: series by columns, named, with categories',
      [
        ['', 'N', 'S'],
        ['Jan', 1, 2],
        ['Feb', 3, 4],
        ['Mar', 5, 6],
      ],
      {
        by: 'columns',
        headers: { row: true, column: true },
        series: 2,
        first: { name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$4', categories: 'Sheet1!$A$2:$A$4' },
      },
    ],
    [
      'no headers: numbers only',
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      {
        by: 'columns',
        headers: { row: false, column: false },
        series: 2,
        first: { values: 'Sheet1!$A$1:$A$3' },
      },
    ],
    [
      'more columns than rows: series by rows',
      [
        ['', 'Jan', 'Feb', 'Mar', 'Apr'],
        ['N', 1, 2, 3, 4],
        ['S', 5, 6, 7, 8],
      ],
      {
        by: 'rows',
        headers: { row: true, column: true },
        series: 2,
        first: { name: 'Sheet1!$A$2', values: 'Sheet1!$B$2:$E$2', categories: 'Sheet1!$B$1:$E$1' },
      },
    ],
    [
      'one column: one series',
      [[4], [5], [6]],
      { by: 'columns', series: 1, first: { values: 'Sheet1!$A$1:$A$3' } },
    ],
    [
      'one column under a header',
      [['Sales'], [4], [5]],
      {
        by: 'columns',
        headers: { row: true, column: false },
        series: 1,
        first: { name: 'Sheet1!$A$1', values: 'Sheet1!$A$2:$A$3' },
      },
    ],
  ];
  it.each(cases)('%s', (_, rows, want) => {
    const r = inferChartData(grid(rows), 'Sheet1', zone(rows.length - 1, rows[0].length - 1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.by).toBe(want.by);
    if (want.headers) expect(r.data.headers).toEqual(want.headers);
    expect(r.data.series.length).toBe(want.series);
    expect(r.data.series[0]).toEqual(want.first);
  });

  it('dates in the first column are categories', () => {
    const rows = [
      [45000, 1],
      [45031, 2],
      [45061, 3],
    ];
    const r = inferChartData(grid(rows), 'Sheet1', zone(2, 1), (_row, col) => col === 0);
    expect(r.ok && r.data.series).toEqual([
      { values: 'Sheet1!$B$1:$B$3', categories: 'Sheet1!$A$1:$A$3' },
    ]);
  });

  it('text only is refused, and so is a selection past the point limit', () => {
    expect(
      inferChartData(
        grid([
          ['a', 'b'],
          ['c', 'd'],
        ]),
        'Sheet1',
        zone(1, 1),
      ),
    ).toMatchObject({ ok: false, reason: 'NoNumericData' });
    const big = inferChartData(() => 1, 'Sheet1', zone(MAX_CHART_POINTS, 0));
    expect(big).toMatchObject({ ok: false, reason: 'ChartTooLarge' });
  });
});
