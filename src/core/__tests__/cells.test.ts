/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CellContent, FormulaTable, SheetCells } from '../cells.js';
import { StringPool } from '../strings.js';
import { StyleTable } from '../styles.js';
import { cellError, type CellValue } from '../values.js';

function store() {
  const pools = { strings: new StringPool(), formulas: new FormulaTable() };
  return { pools, cells: new SheetCells(pools) };
}

const value: fc.Arbitrary<CellValue> = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.string({ maxLength: 6 }),
  fc.boolean(),
  fc.constantFrom(cellError('#DIV/0!'), cellError('#N/A')),
);

const content: fc.Arbitrary<CellContent | null> = fc.oneof(
  fc.constant(null),
  fc.record({ value, style: fc.integer({ min: 0, max: 3 }) }),
  fc.record({
    value: fc.constant(null),
    formula: fc.constantFrom('A1+1', 'SUM(B:B)'),
    style: fc.constant(0),
  }),
);

describe('SheetCells', () => {
  it('reads back what was written, over random writes and clears', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(3000), fc.nat(5), content), { maxLength: 80 }),
        (writes) => {
          const { cells, pools } = store();
          const expected = new Map<string, CellContent>();
          for (const [row, col, c] of writes) {
            cells.set(row, col, c);
            const empty =
              c === null || (c.value === null && c.formula === undefined && c.style === 0);
            if (empty) expected.delete(`${row},${col}`);
            else expected.set(`${row},${col}`, c);
          }
          for (const [key, c] of expected) {
            const [row, col] = key.split(',').map(Number);
            expect(cells.get(row, col)).toEqual(
              c.formula === undefined ? { value: c.value, style: c.style } : c,
            );
          }
          expect(cells.filled).toBe(expected.size);
          expect([...cells.entries()].length).toBe(expected.size);
          // Every string still referenced is in the pool, and nothing else.
          const strings = new Set(
            [...expected.values()].flatMap((c) =>
              typeof c.value === 'string' && c.formula === undefined
                ? [c.value]
                : c.value && typeof c.value === 'object' && c.formula === undefined
                  ? [c.value.error]
                  : [],
            ),
          );
          expect(pools.strings.size).toBe(strings.size);
          expect(pools.formulas.size).toBe(
            [...expected.values()].filter((c) => c.formula !== undefined).length,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('drops a chunk once it is empty', () => {
    const { cells } = store();
    cells.set(5000, 2, { value: 1, style: 0 });
    expect(cells.chunkCount).toBe(1);
    cells.set(5000, 2, null);
    expect(cells.chunkCount).toBe(0);
  });

  it('shifts rows on insert and delete, dropping what falls off the end', () => {
    const { cells } = store();
    cells.set(0, 0, { value: 'a', style: 0 });
    cells.set(1023, 0, { value: 'b', style: 0 });
    cells.set(1024, 0, { value: 'c', style: 0 });
    cells.set(2047, 1, { value: 'z', style: 0 });
    cells.shiftRows(1, 2, 2048);
    expect(cells.get(0, 0)?.value).toBe('a');
    expect(cells.get(1025, 0)?.value).toBe('b');
    expect(cells.get(1026, 0)?.value).toBe('c');
    expect(cells.get(2047, 1)).toBeNull(); // fell off the end
    cells.shiftRows(1, -2, 2048);
    expect(cells.get(1023, 0)?.value).toBe('b');
    expect(cells.get(1024, 0)?.value).toBe('c');
    cells.shiftRows(0, -1, 2048); // deletes 'a'
    expect(cells.get(0, 0)).toBeNull();
    expect(cells.filled).toBe(2);
  });

  it('shifts columns on insert and delete', () => {
    const { cells } = store();
    cells.set(0, 0, { value: 1, style: 0 });
    cells.set(0, 3, { value: 2, style: 0 });
    cells.shiftCols(1, 2, 10);
    expect(cells.get(0, 5)?.value).toBe(2);
    cells.shiftCols(0, -1, 10);
    expect(cells.get(0, 0)).toBeNull();
    expect(cells.get(0, 4)?.value).toBe(2);
    expect(cells.filled).toBe(1);
  });

  it('refuses what a cell cannot hold', () => {
    const { cells } = store();
    expect(() => cells.set(0, 0, { value: Infinity, style: 0 })).toThrow(/cannot hold Infinity/);
    expect(() => cells.set(0, 0, { value: 1, style: 70000 })).toThrow(/No style index/);
  });

  it('holds a million numeric cells in at most 24 bytes each', () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (gc === undefined) throw new Error('Run with --expose-gc (vitest.config.ts sets it).');
    const used = () => {
      gc();
      gc();
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    const before = used();
    const { cells } = store();
    for (let col = 0; col < 10; col += 1) {
      for (let row = 0; row < 100_000; row += 1)
        cells.set(row, col, { value: row * 0.5 + col, style: 0 });
    }
    const perCell = (used() - before) / cells.filled;
    expect(cells.filled).toBe(1_000_000);
    expect(perCell).toBeLessThanOrEqual(24);
    console.log(`memory.numeric.bytesPerCell = ${perCell.toFixed(2)}`);
  });
});

describe('StyleTable', () => {
  it('deduplicates styles by content, whatever the key order', () => {
    const t = new StyleTable();
    const a = t.intern({ bold: true, color: '#f00' });
    expect(t.intern({ color: '#f00', bold: true })).toBe(a);
    expect(t.intern({ bold: false })).toBe(0);
    expect(t.get(a)).toEqual({ bold: true, color: '#f00' });
  });
});

describe('StringPool', () => {
  it('interns once and frees on the last release', () => {
    const p = new StringPool();
    const i = p.intern('x');
    expect(p.intern('x')).toBe(i);
    p.release(i);
    expect(p.size).toBe(1);
    p.release(i);
    expect(p.size).toBe(0);
    expect(() => p.release(i)).toThrow(/released twice/);
  });
});
