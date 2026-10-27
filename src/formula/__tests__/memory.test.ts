/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { createCellsModel } from '../../core/index.js';

describe('formula memory', () => {
  it('holds a formula cell, parsed, registered and evaluated, in at most 200 bytes', () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (gc === undefined) throw new Error('Run with --expose-gc (vitest.config.ts sets it).');
    const used = () => {
      gc();
      gc();
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    const rows = 100_000;
    // Loaded, as a file is: no undo history holding the formulas a second time.
    const sheetRows: Record<string, { cells: Record<string, { v?: number; f?: string }> }> = {};
    for (let r = 0; r < rows; r += 1) {
      const n = r + 1;
      sheetRows[String(r)] = {
        cells: {
          '0': { v: r },
          '1': { f: r === 0 ? 'A1' : `B${n - 1}+A${n}` },
          '2': { f: `A${n}*2` },
          '3': { f: `IF(A${n}>50,A${n},0)` },
          '4': { f: `SUM(A${n}:C${n})` },
        },
      };
    }
    const data = { version: 1, sheets: [{ id: 's1', name: 'Sheet1', rows: sheetRows }] };
    const before = used();
    const m = createCellsModel({ limits: { rows: rows + 10, cols: 10 }, data });
    let total = 0;
    for (let r = 0; r < rows; r += 1)
      for (let c = 1; c <= 4; c += 1) total += m.value('s1', r, c) as number;
    expect(total).toBeGreaterThan(0);
    const formulas = rows * 4;
    // What the numbers themselves take (15.9 B each) is not the formulas'.
    expect(m.stats().engine.parsed).toBe(formulas);
    const perCell = (used() - before) / formulas;
    console.log(`memory.formula.bytesPerCell = ${perCell.toFixed(1)}`);
    expect(perCell).toBeLessThanOrEqual(200);
  }, 60_000);
});
