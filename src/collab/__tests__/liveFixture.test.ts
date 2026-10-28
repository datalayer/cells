/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The fixtures the Python live workbook (C11-09) is tested against:
 * `tests/collab/live.loro`, a document this binding wrote (a table, a
 * formula, a second sheet, a row inserted and a column deleted, so the axis
 * order has explicit and touched entries), with `live.json` the workbook it
 * projects to; and `live-python.loro`, the same document after
 * `datalayer_cells` wrote into it (`dev/live_fixture.py`), read back here.
 * `CELLS_UPDATE_FIXTURES=1` rewrites the first pair.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { createCellsModel } from '../../core/index.js';
import { LoroBinding } from '../binding.js';

const DIR = new URL('../../../tests/collab/', import.meta.url);
const at = (name: string) => new URL(name, DIR);

function build() {
  const m = createCellsModel();
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'Units', 'Gone'],
      ['Jan', 12, 'x'],
      ['Feb', 15, 'y'],
      ['Mar', 19, 'z'],
    ],
  });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 1, col: 3 },
    cells: [[{ formula: 'B2*2' }]],
  });
  m.dispatch({ type: 'ADD_SHEET', name: 'Figures' } as never);
  m.dispatch({ type: 'SET_CELLS', sheet: 's2', at: { row: 0, col: 0 }, cells: [['fig', 1]] });
  const doc = new LoroDoc();
  doc.setPeerId(7);
  new LoroBinding(m, doc, { peer: '7' });
  m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 1, n: 1 });
  m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'cols', at: 2, n: 1 });
  return { m, doc };
}

/** A model projected from a snapshot. */
function open(bytes: Uint8Array) {
  const m = createCellsModel();
  const doc = new LoroDoc();
  doc.setPeerId(9);
  doc.import(bytes);
  new LoroBinding(m, doc, { peer: '9' });
  return m;
}

describe('the live workbook fixtures', () => {
  it('live.loro projects to live.json, as this binding wrote them', () => {
    const { m, doc } = build();
    if (process.env.CELLS_UPDATE_FIXTURES === '1') {
      writeFileSync(at('live.loro'), doc.export({ mode: 'snapshot' }));
      writeFileSync(at('live.json'), `${JSON.stringify(m.toJSON(), null, 2)}\n`);
    }
    const json = JSON.parse(readFileSync(at('live.json'), 'utf8'));
    expect(m.toJSON()).toEqual(json);
    expect(open(new Uint8Array(readFileSync(at('live.loro')))).toJSON()).toEqual(json);
    expect(m.toRows({ top: 0, left: 0, bottom: 4, right: 2 })).toEqual([
      ['Month', 'Units', null],
      [null, null, null],
      ['Jan', 12, 24],
      ['Feb', 15, null],
      ['Mar', 19, null],
    ]);
  });

  it("reads what datalayer_cells wrote into the document (live-python.loro: C3 = 42, Jan's units doubled into E2:E5)", () => {
    const path = at('live-python.loro');
    if (!existsSync(path)) return;
    const m = open(new Uint8Array(readFileSync(path)));
    expect(m.value('s1', 2, 2)).toBe(42);
    expect(m.toRows({ top: 1, left: 4, bottom: 4, right: 4 })).toEqual([[null], [24], [30], [38]]);
    // The sheet the Python side named by its name.
    expect(m.value('s2', 1, 0)).toBe('from python');
    // C10-09: the chart the Python peer added (`LiveWorkbook.add_chart`), read with the same spec.
    expect(m.sheet('s1').charts.get('chart1')).toEqual({
      id: 'chart1',
      type: 'column',
      title: 'Units by month',
      anchor: {
        kind: 'cells',
        from: { row: 1, col: 6, dx: 0, dy: 0 },
        to: { row: 8, col: 10, dx: 0, dy: 0 },
      },
      data: {
        series: [{ values: 'Sheet1!$B$3:$B$5', categories: 'Sheet1!$A$3:$A$5' }],
        by: 'columns',
        headers: { row: false, column: true },
        blanks: 'gap',
      },
      legend: 'bottom',
    });
    // A row inserted above it on the TypeScript side moves its anchor and its ranges.
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 });
    expect(m.sheet('s1').charts.get('chart1')?.data.series[0].values).toBe('Sheet1!$B$4:$B$6');
  });
});
