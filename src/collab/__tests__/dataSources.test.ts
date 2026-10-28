/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A data source binding (C7-03) through Loro: the binding travels on ids,
 * so a peer's rows inserted above it leave it on the same cells; the rows
 * read never travel (each peer reads its own pages).
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { CellsDataSources, createCellsModel, type DataSource } from '../../core/index.js';
import { LoroBinding } from '../binding.js';

const LIMITS = { rows: 2_000, cols: 12 };

const orders: DataSource = {
  id: 'orders',
  rowCount: 100,
  columns: [{ name: 'id' }, { name: 'amount' }],
  fetch: ({ from, to }) =>
    Promise.resolve([
      Array.from({ length: to - from + 1 }, (_, i) => from + i + 1),
      Array.from({ length: to - from + 1 }, (_, i) => (from + i) * 10),
    ]),
};
const Orders = definePlugin({
  name: '@acme/orders',
  contributes: [contribution(CellsDataSources, orders, { id: 'orders' })],
});

function pair() {
  const make = (peer: number) => {
    const model = createCellsModel({ limits: LIMITS, plugins: [Orders] });
    const doc = new LoroDoc();
    doc.setPeerId(peer);
    return { model, doc };
  };
  const a = make(1);
  const b = make(2);
  a.model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [['Orders']] });
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

describe('a data source binding over Loro', () => {
  it('reaches the other peer with its shape, and stays on its cells while the other inserts rows above', async () => {
    const p = pair();
    expect(
      p.a.model.dispatch({
        type: 'BIND_DATA_SOURCE',
        sheet: 's1',
        source: 'orders',
        at: { row: 2, col: 1 },
      }),
    ).toEqual({ ok: true });
    p.sync();
    expect(p.b.model.dataSource('s1')?.binding).toEqual({
      id: 'orders',
      at: { row: 2, col: 1 },
      rows: 100,
      cols: 2,
    });
    // Each peer reads its own pages; the rows never travel.
    p.b.model.value('s1', 2, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.b.model.value('s1', 2, 1)).toBe(1);
    expect(p.a.model.toJSON().sheets[0].rows['2']).toBeUndefined();
    expect(p.b.model.toJSON().sheets[0].rows['2']).toBeUndefined();
    p.b.model.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 3 });
    p.a.model.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'cols', at: 0, n: 1 });
    p.sync();
    for (const m of [p.a.model, p.b.model]) {
      expect(m.dataSource('s1')?.zone).toEqual({ top: 5, left: 2, bottom: 104, right: 3 });
      expect(m.content('s1', 3, 1)?.value).toBe('Orders');
    }
  });

  it('unbinds on both, and a binding whose anchor row is deleted by the other peer is dropped', () => {
    const p = pair();
    p.a.model.dispatch({
      type: 'BIND_DATA_SOURCE',
      sheet: 's1',
      source: 'orders',
      at: { row: 2, col: 1 },
    });
    p.sync();
    p.a.model.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: null });
    p.sync();
    expect(p.b.model.dataSource('s1')).toBeUndefined();
    p.b.model.dispatch({
      type: 'BIND_DATA_SOURCE',
      sheet: 's1',
      source: 'orders',
      at: { row: 10, col: 1 },
    });
    // Concurrently, peer a deletes rows 8–12 (the anchor among them, which its own grid still allows: it is unbound there).
    p.a.model.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 8, n: 5 });
    p.sync();
    expect(p.a.model.dataSource('s1')).toBeUndefined();
    expect(p.b.model.dataSource('s1')).toBeUndefined();
  });
});
