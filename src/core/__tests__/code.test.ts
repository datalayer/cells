/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Code cells in the model (C11-01): a code cell's result is its cell's value,
 * which formulas read; it travels with its row through inserts, deletes and
 * moves; it is one undo step; it round-trips through JSON and Loro; a
 * malformed one is refused with the path of its bad field.
 */

import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { codeAt, codeCell, createCellsModel } from '../index.js';
import { LoroBinding } from '../../collab/binding.js';

const LIMITS = { rows: 50, cols: 10 };

function model() {
  const m = createCellsModel({ limits: LIMITS });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [[1], [2], [3], [{ formula: 'B1*2' }]],
  });
  return m;
}

describe('code cells in the model', () => {
  it('writes the result as the cell value, typed code, read by a formula, in one undo step', () => {
    const m = model();
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 0,
      col: 1,
      code: codeCell('sum(cells["A1:A3"])', { result: 6, executionCount: 1 }),
    });
    expect(m.value('s1', 0, 1)).toBe(6);
    expect(m.value('s1', 3, 0)).toBe(12);
    expect(m.style('s1', 0, 1).type).toBe('code');
    expect(codeAt(m.sheet('s1'), 0, 1)?.source).toBe('sum(cells["A1:A3"])');
    m.undo();
    expect(codeAt(m.sheet('s1'), 0, 1)).toBeUndefined();
    expect(m.value('s1', 0, 1)).toBeNull();
    expect(m.style('s1', 0, 1).type).toBeUndefined();
    m.redo();
    expect(m.value('s1', 0, 1)).toBe(6);
  });

  it('follows its cell through an insert, a move and a delete (and its undo)', () => {
    const m = model();
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 2, col: 1, code: codeCell('1') });
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2 });
    expect(codeAt(m.sheet('s1'), 4, 1)?.source).toBe('1');
    expect(codeAt(m.sheet('s1'), 2, 1)).toBeUndefined();
    m.dispatch({ type: 'MOVE_AXIS', sheet: 's1', axis: 'cols', at: 1, n: 1, to: 4 });
    expect(codeAt(m.sheet('s1'), 4, 3)?.source).toBe('1');
    m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 4, n: 1 });
    expect(m.toJSON().sheets[0].code).toBeUndefined();
    m.undo();
    expect(codeAt(m.sheet('s1'), 4, 3)?.source).toBe('1');
  });

  it('round-trips through JSON', () => {
    const m = model();
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 4,
      col: 2,
      code: codeCell('1/0', {
        result: { error: '#ERROR!' },
        outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: '', traceback: [] }],
        run: 'auto',
        frame: { width: 300, height: 200 },
      }),
    });
    const data = m.toJSON();
    expect(Object.keys(data.sheets[0].code ?? {})).toEqual(['C5']);
    const back = createCellsModel({ limits: LIMITS, data });
    expect(back.toJSON()).toEqual(data);
    expect(back.value('s1', 4, 2)).toEqual({ error: '#ERROR!' });
  });

  it('refuses a malformed code cell with the path of the bad field', () => {
    const m = model();
    const result = m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 0,
      col: 1,
      code: { ...codeCell('1'), run: 'sometimes' } as never,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusals[0].message).toBe("code.run: 'manual' or 'auto'");
  });

  it('reaches a second peer through Loro, and its removal too', () => {
    const a = createCellsModel({ limits: LIMITS });
    const b = createCellsModel({ limits: LIMITS });
    const da = new LoroDoc();
    da.setPeerId(1);
    const db = new LoroDoc();
    db.setPeerId(2);
    new LoroBinding(a, da, { peer: '1' });
    db.import(da.export({ mode: 'snapshot' }));
    new LoroBinding(b, db, { peer: '2' });
    const sync = () => {
      db.import(da.export({ mode: 'update', from: db.oplogVersion() }));
      da.import(db.export({ mode: 'update', from: da.oplogVersion() }));
    };
    a.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 });
    a.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 3,
      col: 1,
      code: codeCell('2+2', { result: 4 }),
    });
    sync();
    expect(b.toJSON().sheets[0].code).toEqual(a.toJSON().sheets[0].code);
    expect(b.value('s1', 3, 1)).toBe(4);
    b.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 });
    sync();
    expect(codeAt(a.sheet('s1'), 4, 1)?.source).toBe('2+2');
    a.dispatch({ type: 'SET_CODE', sheet: 's1', row: 4, col: 1, code: null });
    sync();
    expect(b.toJSON().sheets[0].code).toBeUndefined();
  });
});
