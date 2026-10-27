/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Axis, FRESH_BASE } from '../axis.js';

/** The obvious model: one record per index. */
interface Naive {
  id: number;
  size: number;
  hidden: boolean;
}

function naiveOffset(rows: Naive[], index: number): number {
  let sum = 0;
  for (let i = 0; i < index; i += 1) sum += rows[i].hidden ? 0 : rows[i].size;
  return sum;
}

describe('Axis', () => {
  it('maps offsets and indexes both ways, for random sizes over a million rows', () => {
    const axis = new Axis({ count: 1_048_576, defaultSize: 21 });
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 1_048_575 }), fc.integer({ min: 1, max: 400 })),
          {
            maxLength: 50,
          },
        ),
        fc.integer({ min: 0, max: 1_048_575 }),
        (resizes, probe) => {
          for (const [index, size] of resizes) axis.resize(index, size);
          expect(axis.indexAt(axis.offsetOf(probe))).toBe(probe);
          // Inside the row, not only at its start.
          expect(axis.indexAt(axis.offsetOf(probe) + axis.sizeOf(probe) / 2)).toBe(probe);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('resizes in under 0.1 ms at a million rows', () => {
    const axis = new Axis({ count: 1_048_576, defaultSize: 21 });
    axis.resize(0, 30); // allocate first: the budget is the resize, not the allocation
    const n = 10_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i += 1) axis.resize((i * 7919) % 1_048_576, 10 + (i % 50));
    const each = (performance.now() - t0) / n;
    expect(each).toBeLessThan(0.1);
  });

  it('follows the obvious model through inserts, deletes, resizes and hides', () => {
    const count = 64;
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant('insert' as const),
              at: fc.nat(count - 1),
              n: fc.integer({ min: 1, max: 5 }),
            }),
            fc.record({
              op: fc.constant('delete' as const),
              at: fc.nat(count - 1),
              n: fc.integer({ min: 1, max: 5 }),
            }),
            fc.record({
              op: fc.constant('resize' as const),
              at: fc.nat(count - 1),
              size: fc.integer({ min: 1, max: 90 }),
            }),
            fc.record({
              op: fc.constant('hide' as const),
              at: fc.nat(count - 1),
              hidden: fc.boolean(),
            }),
            fc.record({ op: fc.constant('touch' as const), at: fc.nat(count - 1) }),
          ),
          { maxLength: 40 },
        ),
        (ops) => {
          const axis = new Axis({ count, defaultSize: 20 });
          const naive: Naive[] = Array.from({ length: count }, (_, i) => ({
            id: axis.idAt(i),
            size: 20,
            hidden: false,
          }));
          for (const o of ops) {
            if (o.op === 'insert') {
              if (o.at + o.n > count) continue;
              const ids = axis.insert(o.at, o.n).inserted.ids;
              naive.splice(o.at, 0, ...Array.from(ids, (id) => ({ id, size: 20, hidden: false })));
              naive.length = count;
            } else if (o.op === 'delete') {
              if (o.at + o.n > count) continue;
              const removed = axis.delete(o.at, o.n);
              expect(Array.from(removed.ids)).toEqual(
                naive.slice(o.at, o.at + o.n).map((r) => r.id),
              );
              naive.splice(o.at, o.n);
              for (let i = naive.length; i < count; i += 1)
                naive.push({ id: axis.idAt(i), size: 20, hidden: false });
            } else if (o.op === 'resize') {
              axis.resize(o.at, o.size);
              naive[o.at].size = o.size;
            } else if (o.op === 'hide') {
              axis.setHidden(o.at, o.hidden);
              naive[o.at].hidden = o.hidden;
            } else {
              axis.materialize(o.at);
            }
          }
          for (let i = 0; i < count; i += 1) {
            expect(axis.idAt(i)).toBe(naive[i].id);
            expect(axis.sizeOf(i)).toBe(naive[i].size);
            expect(axis.isHidden(i)).toBe(naive[i].hidden);
            expect(axis.offsetOf(i)).toBe(naiveOffset(naive, i));
          }
          expect(axis.extent).toBe(naiveOffset(naive, count));
          expect(new Set(naive.map((r) => r.id)).size).toBe(count);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('gives an index the same implicit id on two replicas that materialise it independently', () => {
    const a = new Axis({ count: 1000, defaultSize: 20 });
    const b = new Axis({ count: 1000, defaultSize: 20 });
    a.materialize(10);
    b.materialize(500);
    expect(a.materialize(400)).toBe(b.idAt(400));
    expect(a.idAt(999)).toBe(b.idAt(999));
  });

  it('gives inserted indexes fresh ids, never an implicit one', () => {
    const axis = new Axis({ count: 100, defaultSize: 20 });
    const { ids } = axis.insert(5, 3).inserted;
    for (const id of ids) expect(id).toBeGreaterThanOrEqual(FRESH_BASE);
    expect(axis.indexOfId(ids[1])).toBe(6);
  });

  it('undoes an insert, a delete and a move exactly, with the patches they return', () => {
    const count = 40;
    const state = (a: Axis) =>
      Array.from({ length: count }, (_, i) => [a.idAt(i), a.sizeOf(i), a.isHidden(i)] as const);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(count - 1), fc.integer({ min: 1, max: 60 }), fc.boolean()), {
          maxLength: 10,
        }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 40 }),
        fc.boolean(),
        (setup, at, n, to, materializeAll) => {
          const axis = new Axis({ count, defaultSize: 20 });
          if (materializeAll) axis.materialize(count - 1);
          for (const [i, size, hidden] of setup) {
            axis.resize(i, size);
            axis.setHidden(i, hidden);
          }
          const initial = state(axis);
          const { inserted, dropped } = axis.insert(at, n);
          axis.delete(at, n, dropped);
          expect(state(axis)).toEqual(initial);
          const removed = axis.delete(at, n);
          axis.insert(at, n, removed);
          expect(state(axis)).toEqual(initial);
          void inserted;
          if (to < at || to > at + n) {
            if (to <= count) {
              axis.move(at, n, to);
              const back = to < at ? { at: to, to: at + n } : { at: to - n, to: at };
              axis.move(back.at, n, back.to);
              expect(state(axis)).toEqual(initial);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('skips hidden indexes when mapping an offset', () => {
    const axis = new Axis({ count: 10, defaultSize: 10 });
    axis.setHidden(1, true);
    expect(axis.offsetOf(2)).toBe(10);
    expect(axis.indexAt(10)).toBe(2);
    axis.setHidden(1, false);
    expect(axis.indexAt(10)).toBe(1);
  });

  it('refuses what does not fit, with a sentence', () => {
    const axis = new Axis({ count: 10, defaultSize: 10 });
    expect(() => axis.idAt(10)).toThrow(/outside an axis of 10/);
    expect(() => axis.insert(8, 3)).toThrow(/do not fit/);
    expect(() => axis.resize(0, 0)).toThrow(/positive/);
    expect(() => new Axis({ count: 0, defaultSize: 10 })).toThrow(/1 to/);
  });
});
