/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C10-08: charts in Loro. The `charts:<sheetId>` root, ranges in id form,
 * anchors on ids, field-by-field merging: two in-memory peers converge on a
 * chart inserted while the other inserts rows above its range, deleted while
 * the other retitles it, a title and a type changed concurrently, and two
 * series reordered concurrently.
 */

import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { type CellsModel, type ChartSpec, createCellsModel } from '../../core/index.js';
import { LoroBinding } from '../binding.js';

const LIMITS = { rows: 60, cols: 12 };

function pair() {
  const make = (peer: number) => {
    const model = createCellsModel({ limits: LIMITS });
    const doc = new LoroDoc();
    doc.setPeerId(peer);
    return { model, doc };
  };
  const a = make(1);
  const b = make(2);
  a.model.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'North', 'South'],
      ['Jan', 10, 7],
      ['Feb', 12, 9],
      ['Mar', 15, 11],
    ],
  });
  const ba = new LoroBinding(a.model, a.doc, { peer: '1' });
  b.doc.import(a.doc.export({ mode: 'snapshot' }));
  const bb = new LoroBinding(b.model, b.doc, { peer: '2' });
  const sync = () => {
    const ua = a.doc.export({ mode: 'update', from: b.doc.oplogVersion() });
    const ub = b.doc.export({ mode: 'update', from: a.doc.oplogVersion() });
    b.doc.import(ua);
    a.doc.import(ub);
  };
  return { a: { ...a, binding: ba }, b: { ...b, binding: bb }, sync };
}

const chart = (over: Partial<ChartSpec> = {}): Omit<ChartSpec, 'id'> & { id: string } => ({
  id: 'c1',
  type: 'column',
  anchor: {
    kind: 'cells',
    from: { row: 1, col: 5, dx: 0, dy: 0 },
    to: { row: 10, col: 9, dx: 0, dy: 0 },
  },
  data: {
    series: [
      { name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$4', categories: 'Sheet1!$A$2:$A$4' },
      { name: 'Sheet1!$C$1', values: 'Sheet1!$C$2:$C$4', categories: 'Sheet1!$A$2:$A$4' },
    ],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: 'gap',
  },
  title: 'Sales',
  legend: 'bottom',
  ...over,
});

/** JSON with its keys sorted at every level: two peers' workbooks compare whatever order their fields were written in. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'object' && x !== null && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );

const charts = (m: CellsModel) => [...m.sheet('s1').charts.values()];
const same = (p: ReturnType<typeof pair>) => {
  expect(canonical(p.a.model.toJSON())).toBe(canonical(p.b.model.toJSON()));
  return charts(p.a.model);
};

describe('charts in Loro', () => {
  it('a chart inserted on one peer reaches the other, with its ranges and anchor', () => {
    const p = pair();
    expect(p.a.model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart() })).toEqual({
      ok: true,
    });
    p.sync();
    const [c] = same(p);
    expect(c).toMatchObject({ id: 'c1', type: 'column', title: 'Sales' });
    expect(c.data.series[0]).toEqual({
      name: 'Sheet1!$B$1',
      values: 'Sheet1!$B$2:$B$4',
      categories: 'Sheet1!$A$2:$A$4',
    });
    expect(p.b.model.chartData('s1', 'c1').series[0].values).toEqual([10, 12, 15]);
    expect(p.a.doc.getMap('charts:s1').toJSON()).toHaveProperty('c1');
  });

  it('inserted while the other inserts rows above its range: the range and the anchor move on both', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart() });
    p.b.model.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2 });
    p.sync();
    const [c] = same(p);
    expect(c.data.series[0].values).toBe('Sheet1!$B$4:$B$6');
    expect(c.data.series[0].categories).toBe('Sheet1!$A$4:$A$6');
    expect(c.anchor).toMatchObject({ from: { row: 3, col: 5 }, to: { row: 12, col: 9 } });
    expect(p.b.model.chartData('s1', 'c1').series[0].values).toEqual([10, 12, 15]);
  });

  it('deleted while the other retitles it: the delete wins', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart() });
    p.sync();
    p.a.model.dispatch({ type: 'DELETE_CHART', sheet: 's1', id: 'c1' });
    p.b.model.dispatch({
      type: 'UPDATE_CHART',
      sheet: 's1',
      id: 'c1',
      changes: { title: 'Later' },
    });
    p.sync();
    expect(same(p)).toEqual([]);
  });

  it('a title and a type changed concurrently: both kept', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart() });
    p.sync();
    p.a.model.dispatch({
      type: 'UPDATE_CHART',
      sheet: 's1',
      id: 'c1',
      changes: { title: 'Units' },
    });
    p.b.model.dispatch({ type: 'UPDATE_CHART', sheet: 's1', id: 'c1', changes: { type: 'line' } });
    p.sync();
    const [c] = same(p);
    expect(c).toMatchObject({ title: 'Units', type: 'line' });
  });

  it('two series reordered concurrently: both peers end with the same list, each series once', () => {
    const p = pair();
    p.a.model.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: chart({
        data: {
          ...chart().data,
          series: [...chart().data.series, { name: 'Total', values: 'Sheet1!$B$2:$C$4' }],
        },
      }),
    });
    p.sync();
    const [s0, s1, s2] = charts(p.a.model)[0].data.series;
    p.a.model.dispatch({
      type: 'UPDATE_CHART',
      sheet: 's1',
      id: 'c1',
      changes: { data: { ...chart().data, series: [s2, s0, s1] } },
    });
    p.b.model.dispatch({
      type: 'UPDATE_CHART',
      sheet: 's1',
      id: 'c1',
      changes: { data: { ...chart().data, series: [s1, s2, s0] } },
    });
    p.sync();
    const [c] = same(p);
    expect(c.data.series.map((s) => s.name).sort()).toEqual(
      ['Sheet1!$B$1', 'Sheet1!$C$1', 'Total'].sort(),
    );
    expect(c.data.series).toHaveLength(3);
  });

  it('rows of a range deleted by the other peer: the range is #REF!, the anchor stays', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart() });
    p.sync();
    p.b.model.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 1, n: 3 });
    p.sync();
    const [c] = same(p);
    expect(c.data.series[0].values).toBe('#REF!');
    expect(c.data.series[0].name).toBe('Sheet1!$B$1');
    expect(p.a.model.chartData('s1', 'c1').deleted).toEqual(['#REF!']);
  });

  it('undo of a local insert removes the chart on both peers', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: chart() });
    p.sync();
    expect(charts(p.b.model)).toHaveLength(1);
    expect(p.a.binding.undo()).toBe(true);
    p.sync();
    expect(same(p)).toEqual([]);
  });
});
