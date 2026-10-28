/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Code cells in files (C11-07): the `ipynb` exporter writes them as a
 * notebook, one code cell each in reading order with its outputs; an XLSX
 * round trip keeps the sources (in `customXml/cells-code.xml`) and the
 * results (the cells' cached values), drops the outputs and says so in the
 * report. And `codeCells: false` (C11-08): shown, never changed or run.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { CellsExporters, codeCell, codeRunner, createCellsModel, toNotebook } from '../index.js';
import { readXlsx, writeXlsx } from '../../xlsx/index.js';

const stream = (text: string) => ({ output_type: 'stream' as const, name: 'stdout', text });

function model(options: { codeCells?: boolean } = {}) {
  const m = createCellsModel({ limits: { rows: 50, cols: 10 }, ...options });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'Units'],
      ['Jan', 12],
      ['Feb', 15],
    ],
  });
  return m;
}

function withCode() {
  const m = model();
  m.dispatch({
    type: 'SET_CODE',
    sheet: 's1',
    row: 3,
    col: 1,
    code: codeCell('sum(cells["B2:B3"])', {
      result: 27,
      executionCount: 2,
      lastRun: '2026-10-28T10:42:00.000Z',
      outputs: [stream('27\n')],
    }),
  });
  m.dispatch({
    type: 'SET_CODE',
    sheet: 's1',
    row: 1,
    col: 3,
    code: codeCell('"first"', { run: 'auto', frame: null, result: 'first' }),
  });
  return m;
}

describe('code cells in files', () => {
  it('exports the code cells as a notebook, in reading order, with their outputs', async () => {
    const m = withCode();
    const nb = toNotebook(m.workbook);
    expect(nb.nbformat).toBe(4);
    expect(nb.cells.map((c) => c.cell_type)).toEqual(['markdown', 'code', 'code']);
    const [, d2, b4] = nb.cells;
    expect(d2.metadata).toEqual({ cells: { sheet: 'Sheet1', ref: 'D2', run: 'auto' } });
    expect(b4.source).toBe('sum(cells["B2:B3"])');
    expect(b4.outputs).toEqual([stream('27\n')]);
    expect(b4.execution_count).toBe(2);
    const exporter = m.reactor
      .getContributions(CellsExporters)
      .find((c) => c.value.id === 'ipynb')!;
    expect(exporter.value.extension).toBe('.ipynb');
    const text = (await exporter.value.write(m)) as string;
    expect(JSON.parse(text).cells).toHaveLength(3);
  });

  it('round-trips through XLSX: the sources and the results kept, the outputs dropped with a report line', () => {
    const m = withCode();
    const bytes = writeXlsx(m);
    const files = unzipSync(bytes);
    const part = strFromU8(files['customXml/cells-code.xml']);
    expect(part).toContain('ref="B4"');
    expect(part).toContain('sum(cells[&quot;B2:B3&quot;])');
    expect(strFromU8(files['xl/_rels/workbook.xml.rels'])).toContain('customXml/cells-code.xml');
    const { workbook, report } = readXlsx(bytes);
    const code = workbook.sheets[0].code!;
    expect(Object.keys(code).sort()).toEqual(['B4', 'D2']);
    expect(code.B4).toEqual({
      source: 'sum(cells["B2:B3"])',
      language: 'python',
      outputs: [],
      result: 27,
      run: 'manual',
      executionCount: 2,
      lastRun: '2026-10-28T10:42:00.000Z',
    });
    expect(code.D2).toEqual({
      source: '"first"',
      language: 'python',
      outputs: [],
      result: 'first',
      run: 'auto',
      frame: null,
    });
    expect(report.code).toEqual([
      '2 code cells read from customXml/cells-code.xml: the sources and the results, as cached values; the outputs are not in XLSX and were dropped.',
    ]);
    // Back in a model: the cells hold their results, typed code.
    const back = createCellsModel({ data: workbook });
    expect(back.value('s1', 3, 1)).toBe(27);
    expect(back.code('s1', 3, 1)?.source).toBe('sum(cells["B2:B3"])');
    // A workbook with no code cell writes no part and reports nothing.
    const plain = readXlsx(writeXlsx(model()));
    expect(plain.report.code).toEqual([]);
    expect(plain.workbook.sheets[0].code).toBeUndefined();
  });

  it('codeCells: false shows code cells and refuses to make, change or run one', async () => {
    const data = withCode().toJSON();
    const m = createCellsModel({ data, codeCells: false });
    expect(m.code('s1', 3, 1)?.source).toBe('sum(cells["B2:B3"])');
    expect(m.value('s1', 3, 1)).toBe(27);
    const refused = m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 5,
      col: 1,
      code: codeCell('1'),
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusals[0].reason).toBe('CodeCellsOff');
    await expect(codeRunner(m).run({ sheet: 's1', row: 3, col: 1 })).rejects.toThrow(
      'Code cells are off here',
    );
    // Other edits go on.
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 5 }, cells: [[1]] }).ok,
    ).toBe(true);
  });
});
