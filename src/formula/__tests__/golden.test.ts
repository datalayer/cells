/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FUNCTIONS } from '../../builtins/functions/index.js';
import { type CellInput, type CellValue, createCellsModel, isCellError } from '../../core/index.js';

interface Case {
  readonly fn: string;
  readonly formula: string;
  readonly row: number;
  readonly number?: number;
  readonly string?: string;
  readonly boolean?: boolean;
  readonly error?: string;
  readonly source: string;
}

const spec = JSON.parse(
  readFileSync(new URL('../../../tests/formula/cases.json', import.meta.url), 'utf8'),
) as { data: Record<string, CellValue[]>; other: Record<string, CellValue> };
const golden = JSON.parse(
  readFileSync(new URL('../../../tests/formula/golden.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

/** Functions whose value changes on every recalculation: their type is checked, not their value. */
const VOLATILE = new Set(['TODAY', 'NOW', 'RAND', 'RANDBETWEEN']);

/** The workbook the golden values were computed in: the data block, Other, case i in H(i + 1). */
function workbook() {
  const m = createCellsModel({ limits: { rows: 1000, cols: 20 } });
  const columns = Object.values(spec.data);
  const rows: CellInput[][] = [];
  for (let r = 0; r < columns[0].length; r += 1) rows.push(columns.map((col) => col[r]));
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: rows });
  m.dispatch({ type: 'ADD_SHEET', name: 'Other' });
  const other = m.sheets.find((s) => s.name === 'Other')!.id;
  for (const [ref, v] of Object.entries(spec.other)) {
    m.dispatch({
      type: 'SET_CELLS',
      sheet: other,
      at: { row: Number(ref.slice(1)) - 1, col: ref.charCodeAt(0) - 65 },
      cells: [[v]],
    });
  }
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 7 },
    cells: golden.cases.map((c) => [{ formula: c.formula }]),
  });
  return m;
}

const shown = (v: CellValue) =>
  isCellError(v)
    ? { error: v.error }
    : typeof v === 'number'
      ? { number: v }
      : typeof v === 'string'
        ? { string: v }
        : { boolean: v };

describe('the function library against LibreOffice', () => {
  const m = workbook();

  it.each(golden.cases.map((c) => [c.formula, c] as const))('=%s', (_, c) => {
    const v = m.value('s1', c.row, 7);
    if (VOLATILE.has(c.fn)) {
      expect(typeof v).toBe('number');
      return;
    }
    if (c.number !== undefined) {
      expect(shown(v)).toMatchObject({ number: expect.any(Number) });
      const n = v as number;
      expect(Math.abs(n - c.number)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(c.number)));
    } else if (c.string !== undefined) expect(shown(v)).toEqual({ string: c.string });
    else if (c.boolean !== undefined) expect(shown(v)).toEqual({ boolean: c.boolean });
    else expect(shown(v)).toEqual({ error: c.error });
  });

  it('covers every function shipped, each with a documented example', () => {
    const tested = new Set(golden.cases.map((c) => c.fn));
    const untested = FUNCTIONS.map((f) => f.name).filter((n) => !tested.has(n));
    expect(untested).toEqual([]);
    expect(FUNCTIONS.filter((f) => f.examples.length === 0 || f.description === '')).toEqual([]);
    expect(FUNCTIONS.length).toBeGreaterThanOrEqual(100);
  });
});
