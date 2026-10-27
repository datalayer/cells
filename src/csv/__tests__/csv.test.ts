/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCellsModel } from '../../core/index.js';
import {
  CsvParser,
  type Delimiter,
  importCsv,
  inferField,
  parseCsvText,
  sniffDelimiter,
  toCsv,
} from '../index.js';

const corpus = JSON.parse(
  readFileSync(new URL('../../../tests/csv/corpus.json', import.meta.url), 'utf8'),
) as { cases: { name: string; input: string; rows: string[][] }[] };

describe('the RFC 4180 corpus', () => {
  it.each(corpus.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(parseCsvText(c.input)).toEqual(c.rows);
    // In pieces of every size: a quote, a CRLF or the BOM split across two.
    for (let size = 1; size <= Math.min(8, c.input.length); size += 1) {
      const rows: string[][] = [];
      const parser = new CsvParser((r) => rows.push(r), sniffDelimiter(c.input) as Delimiter);
      for (let i = 0; i < c.input.length; i += size) parser.push(c.input.slice(i, i + size));
      parser.end();
      expect([size, rows]).toEqual([size, c.rows]);
    }
  });
});

describe('inference', () => {
  it('reads numbers, percentages, booleans and dates; leading zeros stay text', () => {
    expect(inferField('12.5')).toEqual({ value: 12.5 });
    expect(inferField('-1,234.5')).toEqual({ value: -1234.5 });
    expect(inferField('1e3')).toEqual({ value: 1000 });
    expect(inferField('12%')).toEqual({ value: 0.12, format: '0%' });
    expect(inferField('true')).toEqual({ value: true });
    expect(inferField('2023-03-15')).toEqual({ value: 45000, format: 'yyyy-mm-dd' });
    expect(inferField('2023-03-15 12:00')).toEqual({
      value: 45000.5,
      format: 'yyyy-mm-dd hh:mm:ss',
    });
    expect(inferField('3/15/2023')).toEqual({ value: 45000, format: 'm/d/yyyy' });
    expect(inferField('15/3/2023', { dates: 'dmy' })).toEqual({ value: 45000, format: 'd/m/yyyy' });
    expect(inferField('2023-02-30')).toEqual({ value: '2023-02-30' });
    expect(inferField('007')).toEqual({ value: '007' });
    expect(inferField('1,5', { decimal: ',' })).toEqual({ value: 1.5 });
    expect(inferField('1.234,5', { decimal: ',' })).toEqual({ value: 1234.5 });
    expect(inferField('12', { infer: false })).toEqual({ value: '12' });
    expect(inferField('')).toEqual({ value: null });
  });
});

describe('a model in and out', () => {
  it('imports typed columns in chunks, dates with their format, and exports back', async () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 10 } });
    const text =
      'name,born,share,ok\r\nAda,2023-03-15,50%,TRUE\r\n"Grace, R.",1815-12-10,12.5%,FALSE\r\n';
    const summary = await importCsv(m, text, { worker: false, chunkRows: 2 });
    expect(summary).toEqual({ delimiter: ',', rows: 3, cols: 4 });
    expect(m.toRows({ top: 0, left: 0, bottom: 2, right: 3 })).toEqual([
      ['name', 'born', 'share', 'ok'],
      ['Ada', 45000, 0.5, true],
      ['Grace, R.', '1815-12-10', 0.125, false],
    ]);
    expect(m.style('s1', 1, 1)).toEqual({ format: 'yyyy-mm-dd' });
    expect(m.style('s1', 1, 2)).toEqual({ format: '0%' });
    expect(toCsv(m, { zone: { top: 0, left: 0, bottom: 2, right: 0 } })).toBe(
      'name\r\nAda\r\n"Grace, R."\r\n',
    );
  });

  it('writes formulas as typed or as their values, quoting what must be', () => {
    const m = createCellsModel({ limits: { rows: 10, cols: 5 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [[1, 2, { formula: 'A1+B1' }, 'say "hi"', ' pad']],
    });
    expect(toCsv(m)).toBe('1,2,3,"say ""hi"""," pad"\r\n');
    expect(toCsv(m, { formulas: true, delimiter: ';' })).toBe('1;2;=A1+B1;"say ""hi""";" pad"\r\n');
  });
});
