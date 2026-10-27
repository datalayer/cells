/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { type CellsModel, createCellsModel } from '../../core/index.js';
import { LoroBinding } from '../binding.js';

const z = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });

/** Two peers on one document, connected by hand: `sync` delivers everything both ways. */
function pair() {
  const make = (peer: number) => {
    const model = createCellsModel({ limits: { rows: 200, cols: 20 } });
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
      ['a', 'b', 'c'],
      [1, 2, 3],
    ],
  });
  const ba = new LoroBinding(a.model, a.doc, { peer: '1' });
  // b joins: it receives a's document, then binds to it.
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

const rows = (m: CellsModel, zone = z(0, 0, 3, 4)) => m.toRows(zone);
const same = (p: ReturnType<typeof pair>) =>
  expect(JSON.stringify(p.a.model.toJSON())).toBe(JSON.stringify(p.b.model.toJSON()));

describe('the Loro binding, two in-memory peers', () => {
  it('joins: the second peer shows what the first wrote', () => {
    const p = pair();
    expect(rows(p.b.model, z(0, 0, 1, 2))).toEqual([
      ['a', 'b', 'c'],
      [1, 2, 3],
    ]);
    same(p);
  });

  it('a column inserted while the other edits B1: the edit stays in its column', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'cols', at: 1, n: 1 });
    p.b.model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 1 }, cells: [['B!']] });
    p.sync();
    same(p);
    // What was column B is now C, with b's edit in it; the new column B is empty.
    expect(rows(p.a.model, z(0, 0, 1, 3))).toEqual([
      ['a', null, 'B!', 'c'],
      [1, null, 2, 3],
    ]);
  });

  it('a sheet deleted while the other edits it: gone on both, nothing broken', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'ADD_SHEET', name: 'Two' });
    p.sync();
    const two = p.b.model.sheets.find((s) => s.name === 'Two')!.id;
    p.a.model.dispatch({ type: 'DELETE_SHEET', sheet: two });
    p.b.model.dispatch({
      type: 'SET_CELLS',
      sheet: two,
      at: { row: 0, col: 0 },
      cells: [['late']],
    });
    p.sync();
    same(p);
    expect(p.a.model.sheets.map((s) => s.name)).toEqual(['Sheet1']);
  });

  it('a merge while the other writes inside it: both see one merge and the same cells', () => {
    const p = pair();
    p.a.model.dispatch({ type: 'MERGE', sheet: 's1', zone: z(0, 0, 1, 1) });
    p.b.model.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 1 },
      cells: [['inside']],
    });
    p.sync();
    same(p);
    expect(p.a.model.sheet('s1').merges).toEqual([z(0, 0, 1, 1)]);
  });

  it('formulas follow rows the other inserts, and turn #REF! when the other deletes them', () => {
    const p = pair();
    p.a.model.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 5, col: 0 },
      cells: [[{ formula: 'SUM(A2:C2)+$B$2+$A$1' }]],
    });
    p.sync();
    p.b.model.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2 });
    p.sync();
    same(p);
    expect(p.a.model.content('s1', 7, 0)?.formula).toBe('SUM(A4:C4)+$B$4+$A$3');
    expect(p.a.model.value('s1', 7, 0)).toMatchObject({ error: '#VALUE!' }); // $A$3 is the text 'a'
    expect(p.a.model.content('s1', 2, 0)?.value).toBe('a');
    p.a.model.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 3, n: 1 });
    p.sync();
    same(p);
    expect(p.b.model.content('s1', 6, 0)?.formula).toBe('SUM(#REF!)+#REF!+$A$3');
  });

  it('undo undoes one peer’s own change only', () => {
    const p = pair();
    p.a.model.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 3, col: 0 },
      cells: [['from a']],
    });
    p.sync();
    p.b.model.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 3, col: 1 },
      cells: [['from b']],
    });
    p.sync();
    expect(p.a.binding.undo()).toBe(true);
    p.sync();
    same(p);
    expect(rows(p.b.model, z(3, 0, 3, 1))).toEqual([[null, 'from b']]);
  });
});
