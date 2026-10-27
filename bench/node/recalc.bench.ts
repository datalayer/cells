/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The recalculation budgets: an edit, then every value it changes read
 * (reads force evaluation, so what is measured is the edit, the propagation
 * through the dependency graph and the evaluation of every dependent).
 */

import { bench, describe } from 'vitest';
import { type CellsModel, createCellsModel } from '../../src/core/index.js';

// Warmed up well (the JIT, the shapes), then enough runs that one collection pause is not the p99.
const ONCE = { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 };
const MANY = { iterations: 200, time: 0, warmupIterations: 20, warmupTime: 0 };

/** A column of `n` formulas below one input: `=$A$1*k` (wide) or `=A{k-1}+1` (deep). */
function column(n: number, formula: string): CellsModel {
  const m = createCellsModel({ limits: { rows: n + 10, cols: 4 } });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[1]] });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 0 }, cells: [[{ formula }]] });
  const zone = (bottom: number) => ({ top: 1, left: 0, bottom, right: 0 });
  m.dispatch({ type: 'FILL', sheet: 's1', source: zone(1), target: zone(n) });
  for (let r = 1; r <= n; r += 1) m.value('s1', r, 0);
  return m;
}

function edit(m: CellsModel, n: number, input: number): number {
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[input]] });
  let total = 0;
  for (let r = 1; r <= n; r += 1) total += m.value('s1', r, 0) as number;
  if (!Number.isFinite(total)) throw new Error('A dependent did not evaluate.');
  return total;
}

describe('recalculation', () => {
  const local = column(1_000, '$A$1*2+ROUND(A1,0)');
  let i = 0;
  bench('recalc.local.ms', () => void edit(local, 1_000, (i += 1)), MANY);

  const wide = column(10_000, '$A$1*2');
  bench('recalc.wide.ms', () => void edit(wide, 10_000, (i += 1)), MANY);

  const deep = column(100_000, 'A1+1');
  bench('recalc.deep.ms', () => void edit(deep, 100_000, (i += 1)), ONCE);

  // 1 M values in A:J, and in K a SUM over each row's ten: loaded from a file, every formula read.
  const rows = 100_000;
  const sheetRows: Record<string, { cells: Record<string, { v?: number; f?: string }> }> = {};
  for (let r = 0; r < rows; r += 1) {
    const cells: Record<string, { v?: number; f?: string }> = {};
    for (let c = 0; c < 10; c += 1) cells[String(c)] = { v: (r * 7 + c * 13) % 1000 };
    cells['10'] = { f: `SUM(A${r + 1}:J${r + 1})` };
    sheetRows[String(r)] = { cells };
  }
  const data = { version: 1, sheets: [{ id: 's1', name: 'Sheet1', rows: sheetRows }] };
  bench(
    'recalc.full.ms',
    () => {
      const m = createCellsModel({ limits: { rows: rows + 10, cols: 12 }, data });
      let total = 0;
      for (let r = 0; r < rows; r += 1) total += m.value('s1', r, 10) as number;
      if (!Number.isFinite(total)) throw new Error('A formula did not evaluate.');
    },
    { iterations: 3, time: 0, warmupIterations: 1, warmupTime: 0 },
  );
});
