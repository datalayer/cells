/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CellsModel, createCellsModel } from '../../core/index.js';
import { readXlsx, writeXlsx } from '../index.js';

const FIXTURES = ['values-formulas', 'styles', 'layout', 'charts'];

const open = (bytes: Uint8Array) => createCellsModel({ data: readXlsx(bytes).workbook });

/** What a workbook holds, styles resolved (their indexes differ between files). */
function contents(m: CellsModel) {
  return m.sheets.map((sheet) => {
    const s = m.sheet(sheet.id);
    const cells: Record<string, unknown> = {};
    for (const [r, c, content] of s.cells.entries()) {
      cells[`${r},${c}`] = {
        value: m.value(sheet.id, r, c),
        formula: content.formula,
        style: m.style(sheet.id, r, c),
      };
    }
    const sizes = (axis: typeof s.rows, n: number) =>
      Array.from({ length: n }, (_, i) => [axis.sizeOf(i), axis.isHidden(i)]);
    return {
      name: sheet.name,
      cells,
      rows: sizes(s.rows, 12),
      cols: sizes(s.cols, 6),
      merges: s.merges,
      frozen: s.frozen,
      charts: [...s.charts.values()].map(({ id: _id, ...spec }) => spec),
    };
  });
}

describe('XLSX round trip', () => {
  it.each(FIXTURES)('%s: read, written, read again, the same', (name) => {
    const original = open(
      new Uint8Array(readFileSync(new URL(`../../../tests/xlsx/${name}.xlsx`, import.meta.url))),
    );
    const written = writeXlsx(original);
    // CELLS_XLSX_OUT=dir keeps the outputs, for scripts/xlsx-check.py to open in LibreOffice.
    const out = process.env.CELLS_XLSX_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/${name}.xlsx`, written);
    }
    expect(contents(open(written))).toEqual(contents(original));
  });

  it('writes what a model made from scratch holds', () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 10 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [
        ['  padded', 'a < b & "c"', { formula: 'LEN(A1)' }, { formula: 'A1&"!"' }],
        [true, { formula: 'NA()' }, 0.1, null],
      ],
    });
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 1, left: 2, bottom: 1, right: 2 },
      style: { format: '0.000%', bold: true },
    });
    expect(contents(open(writeXlsx(m)))).toEqual(contents(m));
  });
});
