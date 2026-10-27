/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createCellsModel } from '../../core/index.js';
import { display } from '../../render/numberFormat.js';
import { readXlsx } from '../index.js';

/** One of the round-trip workbooks (scripts/xlsx-fixtures.py), opened as a model. */
function open(name: string) {
  const { workbook, report } = readXlsx(
    new Uint8Array(readFileSync(new URL(`../../../tests/xlsx/${name}.xlsx`, import.meta.url))),
  );
  return { model: createCellsModel({ data: workbook }), report };
}

const shown = (m: ReturnType<typeof open>['model'], sheet: string, row: number, col: number) =>
  display(m.value(sheet, row, col), m.style(sheet, row, col).format).text;

describe('the XLSX reader, on the round-trip workbooks', () => {
  it('values-formulas: values, formulas filled down, an error, a second sheet', () => {
    const { model: m, report } = open('values-formulas');
    expect(report).toEqual({ sheets: 2, cells: 25, formulas: 11, skipped: [] });
    expect(m.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Data']);
    expect(m.toRows({ top: 0, left: 0, bottom: 3, right: 3 })).toEqual([
      ['Item', 'Amount', 'Double', 'Running'],
      ['Rent', 1200, 2400, 1200],
      ['Food', 450.5, 901, 1650.5],
      ['Transport', 349.5, 699, 2000],
    ]);
    expect(m.content('s1', 3, 3)?.formula).toBe('SUM(B$2:B4)');
    expect(m.toRows({ top: 5, left: 0, bottom: 6, right: 3 })).toEqual([
      ['Total', 2000, null, null],
      [true, { error: '#DIV/0!', message: 'Division by zero.' }, 50, 'ab'],
    ]);
    expect(m.content('s1', 6, 2)?.formula).toBe('Data!A1+Data!A2');
    expect(shown(m, 's1', 7, 0)).toBe('2023-03-15');
  });

  it('styles: fonts, colours, fill, borders, alignment, wrap and number formats', () => {
    const { model: m } = open('styles');
    const style = (row: number, col = 0) => m.style('s1', row, col);
    expect(style(0)).toEqual({ bold: true });
    expect(style(1)).toEqual({ italic: true });
    expect(style(2)).toEqual({ underline: true });
    expect(style(3)).toEqual({ strike: true });
    expect(style(4)).toEqual({ color: '#ff0000' });
    expect(style(5)).toEqual({ fill: '#ffff00' });
    expect(style(6)).toEqual({ size: 16 });
    expect(style(7)).toEqual({ align: 'right' });
    expect(style(8)).toEqual({ align: 'center' });
    expect(style(9)).toEqual({ wrap: true });
    const side = { style: 'thin', color: '#0000ff' };
    expect(style(10)).toEqual({ borders: { top: side, right: side, bottom: side, left: side } });
    expect([0, 1, 2, 3, 4].map((r) => shown(m, 's1', r, 1))).toEqual([
      '1,234.50',
      '25%',
      '2023-03-15',
      '$1,234.50',
      '5.00E-01',
    ]);
  });

  it('layout: merges, sizes, hidden rows and columns, frozen panes, three sheets', () => {
    const { model: m } = open('layout');
    const s = m.sheet('s1');
    expect(m.sheets.map((x) => x.name)).toEqual(['Layout', 'Second', 'Third sheet']);
    expect(s.merges).toEqual([
      { top: 0, left: 0, bottom: 1, right: 1 },
      { top: 4, left: 2, bottom: 5, right: 3 },
    ]);
    expect(s.cols.sizeOf(0)).toBeGreaterThanOrEqual(145);
    expect(s.cols.sizeOf(0)).toBeLessThanOrEqual(155);
    expect(s.rows.sizeOf(1)).toBe(38);
    expect([s.rows.isHidden(3), s.cols.isHidden(2), s.rows.isHidden(2)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(s.frozen).toEqual({ rows: 2, cols: 1 });
    expect(m.value(m.sheets[2].id, 1, 1)).toBe(3);
  });
});

describe('the XLSX reader, on parts written by hand', () => {
  /** A package of a workbook with one sheet. */
  function pack(sheet: string, extra: Record<string, string> = {}): Uint8Array {
    return zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>' +
          '<definedNames><definedName name="Rate">S!$A$1</definedName></definedNames></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
    });
  }

  it('expands shared formulas, reads inline and rich strings, and reports what it skips', () => {
    const { workbook, report } = readXlsx(
      pack(
        '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>' +
          '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>x &amp; y</t></is></c><c r="B3"><f t="shared" si="0"/></c></row>' +
          '<row r="4"><c r="A4" t="s"><v>0</v></c><c r="B4" t="e"><v>#N/A</v></c></row>',
        {
          'xl/sharedStrings.xml':
            '<sst><si><r><t>rich </t></r><r><t>text</t></r><rPh><t>skip</t></rPh></si></sst>',
          'xl/media/image1.png': 'png',
        },
      ),
    );
    const cells = workbook.sheets[0].rows;
    expect(cells['1'].cells['1']).toEqual({ f: 'A2*2' });
    expect(cells['2'].cells['1']).toEqual({ f: 'A3*2' });
    expect(cells['2'].cells['0']).toEqual({ v: 'x & y' });
    expect(cells['3'].cells['0']).toEqual({ v: 'rich text' });
    expect(cells['3'].cells['1']).toEqual({ v: { error: '#N/A' } });
    expect(report.skipped).toEqual([
      { feature: 'defined name', count: 1 },
      { feature: 'image', count: 1 },
    ]);
  });

  it('reads cells that do not say where they are, by their order', () => {
    const { workbook } = readXlsx(
      pack('<row r="2"><c><v>5</v></c><c t="b"><v>1</v></c></row><row><c><v>7</v></c></row>'),
    );
    expect(workbook.sheets[0].rows).toEqual({
      '1': { cells: { '0': { v: 5 }, '1': { v: true } } },
      '2': { cells: { '0': { v: 7 } } },
    });
  });

  it('refuses what is no XLSX package', () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow(/not an XLSX package/);
    expect(() => readXlsx(zipSync({ 'a.txt': strToU8('a') }))).toThrow(/no xl\/workbook.xml/);
  });
});
