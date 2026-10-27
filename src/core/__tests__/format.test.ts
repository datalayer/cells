/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURES, type Fixture } from '../../../bench/fixtures/fixtures.js';
import { type CellsWorkbook, createCellsModel, fromRows, validateWorkbook } from '../index.js';

/** The corpus the TypeScript and the Python loaders both read (tests/format). */
const FORMAT = fileURLToPath(new URL('../../../tests/format/', import.meta.url));
const CORPUS = join(FORMAT, 'workbooks');
const MALFORMED = JSON.parse(readFileSync(join(FORMAT, 'malformed.json'), 'utf8')) as {
  cases: { name: string; data: unknown; message: string }[];
};

/** A fixture's first rows (about 20,000 cells) as a workbook, with sizes, a merge and a frozen pane to carry. */
export function workbookOf(f: Fixture, rows = Math.floor(20_000 / f.cols)): CellsWorkbook {
  const out: Record<
    string,
    { cells: Record<string, { v?: number | string; f?: string; s?: number }> }
  > = {};
  for (let r = 0; r < Math.min(rows, f.rows); r += 1) {
    for (let c = 0; c < f.cols; c += 1) {
      const v = f.cell(r, c);
      if (v === null) continue;
      const cell = typeof v === 'string' && v.startsWith('=') ? { f: v.slice(1) } : { v };
      (out[r] ??= { cells: {} }).cells[c] = r % 7 === 0 ? { ...cell, s: 1 } : cell;
    }
  }
  return {
    version: 1,
    sheets: [
      {
        id: 's1',
        name: f.name,
        rows: out,
        sizes: { rows: { '3': 40 }, cols: { '1': 160 } },
        hidden: { cols: [4] },
        merges: [{ top: 0, left: 8, bottom: 1, right: 9 }],
        frozen: { rows: 1, cols: 1 },
      },
      { id: 's2', name: 'Notes', rows: { '0': { cells: { '0': { v: { error: '#N/A' } } } } } },
    ],
    styles: [{}, { bold: true, fill: '#ffeeaa', format: '#,##0.00' }],
  };
}

describe('the CellsWorkbook format', () => {
  for (const f of Object.values(FIXTURES)) {
    it(`round-trips the ${f.name} fixture losslessly`, () => {
      const data = workbookOf(f);
      // Merged cells other than the top-left are not part of the comparison data.
      const model = createCellsModel({ data });
      expect(model.toJSON()).toEqual(data);
      expect(createCellsModel({ data: model.toJSON() }).toJSON()).toEqual(data);
    });
  }

  it('builds a workbook from rows, and reads them back', () => {
    const rows = [
      [1, 'a', true],
      [null, 2.5, { error: '#DIV/0!' as const }],
    ];
    const model = createCellsModel({ data: fromRows(rows) });
    expect(model.toRows({ top: 0, left: 0, bottom: 1, right: 2 })).toEqual(rows);
  });

  for (const { name, data, message } of MALFORMED.cases) {
    it(`refuses ${name}, naming the path`, () => {
      expect(() => validateWorkbook(data)).toThrow(new RegExp(message));
      expect(() => createCellsModel({ data })).toThrow(new RegExp(message));
    });
  }

  for (const file of readdirSync(CORPUS).filter((f) => f.endsWith('.json'))) {
    it(`round-trips the shared corpus file ${file} unchanged`, () => {
      const data = JSON.parse(readFileSync(join(CORPUS, file), 'utf8'));
      expect(createCellsModel({ data }).toJSON()).toEqual(data);
    });
  }

  it('keeps the shared corpus in step with the fixtures', () => {
    for (const f of Object.values(FIXTURES)) {
      const data = JSON.parse(readFileSync(join(CORPUS, `${f.name}.json`), 'utf8'));
      expect(data).toEqual(workbookOf(f, Math.floor(2000 / f.cols)));
    }
  });
});
