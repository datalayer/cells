/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { AxisOrder, implicitId, insert, move, remove } from '../axis.js';

const COUNT = 1_048_576;

function peer(id: number) {
  const doc = new LoroDoc();
  doc.setPeerId(id);
  return { doc, rows: doc.getMap('rows:s1'), cells: doc.getMap('cells:s1'), counter: { next: 0 } };
}

/** Exchange everything both ways. */
function sync(a: LoroDoc, b: LoroDoc) {
  a.commit();
  b.commit();
  const ua = a.export({ mode: 'update' });
  const ub = b.export({ mode: 'update' });
  b.import(ua);
  a.import(ub);
}

const order = (p: ReturnType<typeof peer>, n = 12) => AxisOrder.of(p.rows, n).ids();

describe('the axis encoding, two peers', () => {
  it('writes far beyond what either touched land on the same row, whatever else happens', () => {
    const a = peer(1);
    const b = peer(2);
    // Both write row 2,000 of a sheet nobody touched; b also inserts a row near the top.
    a.cells.set(`${implicitId(1999)}.0`, 'from a');
    b.cells.set(`${implicitId(1999)}.1`, 'from b');
    insert(b.rows, COUNT, 5, 1, '2', b.counter);
    sync(a.doc, b.doc);
    for (const p of [a, b]) {
      const ids = AxisOrder.of(p.rows, 2005).ids();
      // The row is now at position 2,000 (one inserted above), on both peers, both cells on it.
      expect(ids[2000]).toBe(implicitId(1999));
      expect(p.cells.get(`${implicitId(1999)}.0`)).toBe('from a');
      expect(p.cells.get(`${implicitId(1999)}.1`)).toBe('from b');
    }
    expect(a.doc.toJSON()).toEqual(b.doc.toJSON());
  });

  it('two inserts at one place keep both rows, in one order on both peers', () => {
    const a = peer(1);
    const b = peer(2);
    const ia = insert(a.rows, COUNT, 3, 2, '1', a.counter);
    const ib = insert(b.rows, COUNT, 3, 1, '2', b.counter);
    sync(a.doc, b.doc);
    expect(order(a)).toEqual(order(b));
    const ids = order(a, 6);
    expect(ids.slice(0, 3)).toEqual([implicitId(0), implicitId(1), implicitId(2)]);
    expect(new Set(ids.slice(3, 6))).toEqual(new Set([...ia, ...ib]));
    expect(ids).toContain(implicitId(3));
  });

  it('a row deleted by both is deleted once; a row deleted by one and written by the other is gone', () => {
    const a = peer(1);
    const b = peer(2);
    remove(a.rows, COUNT, 2, 1);
    remove(b.rows, COUNT, 2, 2);
    b.cells.set(`${implicitId(4)}.0`, 'kept');
    sync(a.doc, b.doc);
    expect(order(a, 6)).toEqual(order(b, 6));
    expect(order(a, 6)).toEqual([0, 1, 4, 5].map(implicitId));
    expect(a.cells.get(`${implicitId(4)}.0`)).toBe('kept');
  });

  it('inserting between rows again and again keeps the order, until no key is left', () => {
    const a = peer(1);
    const made: string[] = [];
    // Always right after row 2 (key 1): each new row's key halves the gap above 1.
    for (let k = 0; k < 40; k += 1) made.push(...insert(a.rows, 12, 2, 1, '1', a.counter));
    expect(order(a, 12).slice(2, 42)).toEqual([...made].reverse());
    expect(() => {
      for (let k = 0; k < 40; k += 1) insert(a.rows, 12, 2, 1, '1', a.counter);
    }).toThrow(/No order key is left/);
  });
});

describe('positions and ids', () => {
  it('idAt and positionOf agree with the full order, across inserts, deletes and moves', () => {
    const a = peer(1);
    insert(a.rows, 20, 3, 2, '1', a.counter);
    remove(a.rows, 20, 7, 3);
    move(a.rows, 20, 10, 2, 1);
    insert(a.rows, 20, 0, 1, '1', a.counter);
    const order = AxisOrder.of(a.rows, 20);
    const ids = order.ids();
    expect(order.length).toBe(ids.length);
    ids.forEach((id, p) => {
      expect([p, order.idAt(p)]).toEqual([p, id]);
      expect([id, order.positionOf(id)]).toEqual([id, p]);
    });
    expect(order.idAt(ids.length)).toBeUndefined();
    expect(order.positionOf(implicitId(7))).toBeUndefined();
  });
});
