/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The browser benches' page (bench/browser/grid.mjs drives it): a model of a
 * bench fixture built before the grid mounts, then the grid mounted full
 * window, with marks for first paint. Not linked from the examples' menu.
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import {
  CellsDataSources,
  type CellsHandle,
  type CellsModel,
  type CellValue,
  createCellsModel,
  type DataSource,
  Spreadsheet,
} from '@datalayer/cells';
import { importCsv } from '@datalayer/cells/csv';
import { readXlsxFile, writeXlsx } from '@datalayer/cells/xlsx';
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { FIXTURES, type FixtureName } from '../../bench/fixtures/fixtures';

const handle = createRef<CellsHandle>();

/** Build the model of a fixture, as a file is opened: no undo steps. */
function build(name: FixtureName): CellsModel {
  const f = FIXTURES[name];
  const model = createCellsModel();
  const columns: CellValue[][] = [];
  for (let c = 0; c < f.cols; c += 1) {
    const col: CellValue[] = new Array(f.rows);
    for (let r = 0; r < f.rows; r += 1) col[r] = f.cell(r, c);
    columns.push(col);
  }
  model.loadColumns('s1', { row: 0, col: 0 }, columns);
  return model;
}

const api = {
  /** Build the model, then mount the grid; resolves with the first-paint time. */
  async mount(name: FixtureName): Promise<{ buildMs: number; firstPaintMs: number }> {
    const t0 = performance.now();
    const model = build(name);
    const buildMs = performance.now() - t0;
    performance.clearMarks();
    performance.mark('cells:mount');
    createRoot(document.getElementById('root')!).render(
      <Spreadsheet ref={handle} model={model} aria-label="Bench" />,
    );
    await new Promise<void>((resolve) => {
      const wait = () =>
        performance.getEntriesByName('cells:first-frame').length > 0
          ? resolve()
          : requestAnimationFrame(wait);
      wait();
    });
    const measure = performance.measure('cells:first-paint', 'cells:mount', 'cells:first-frame');
    return { buildMs, firstPaintMs: measure.duration };
  },
  /**
   * A chain of `n` formulas below one input (`A2` is `=A1+1`, and so on),
   * mounted, every value computed; `edit` then changes the input and resolves
   * once the background recalculation is done.
   */
  async chain(n: number): Promise<void> {
    const model = createCellsModel({ limits: { rows: n + 10, cols: 10 } });
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[1]] });
    model.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [[{ formula: 'A1+1' }]],
    });
    const zone = (bottom: number) => ({ top: 1, left: 0, bottom, right: 0 });
    model.dispatch({ type: 'FILL', sheet: 's1', source: zone(1), target: zone(n) });
    chained = model;
    createRoot(document.getElementById('root')!).render(
      <Spreadsheet ref={handle} model={model} aria-label="Bench" />,
    );
    await idle(model);
  },
  async edit(value: number): Promise<number> {
    const model = chained!;
    const t0 = performance.now();
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[value]] });
    await idle(model);
    return performance.now() - t0;
  },
  /** Make a CSV file of `rows` × 10 (numbers and words), for `csvImport`. */
  csvFile(rows: number): void {
    const lines: string[] = [];
    for (let r = 0; r < rows; r += 1) {
      const f: string[] = [];
      for (let c = 0; c < 10; c += 1) f.push(c % 3 === 0 ? `word ${r}` : String((r * 7 + c) / 4));
      lines.push(f.join(','));
    }
    csvFile = new Blob([lines.join('\n')], { type: 'text/csv' });
  },
  /** Import the file `csvFile` made through the worker into a fresh model; resolves with the time it took. */
  async csvImport(): Promise<{ ms: number; cells: number }> {
    const model = createCellsModel();
    const t0 = performance.now();
    await importCsv(model, csvFile!);
    return { ms: performance.now() - t0, cells: model.stats().cells };
  },
  /**
   * C7-03: a synthetic data source of `rows` rows × 12 text and number columns,
   * answered a page at a time after `delayMs` (as a server would), bound at A1
   * of a sheet of `rows` rows, the grid mounted full window. Every visible cell
   * is filled once its page arrives.
   */
  async dataSource(rows: number, delayMs: number): Promise<void> {
    const cols = 12;
    const source: DataSource = {
      id: 'synthetic',
      rowCount: rows,
      columns: Array.from({ length: cols }, (_, c) => ({
        name: `C${c + 1}`,
        type: c % 3 === 0 ? 'string' : 'number',
      })),
      fetch: ({ from, to }) =>
        new Promise((resolve) => {
          setTimeout(() => {
            const n = to - from + 1;
            resolve(
              Array.from({ length: cols }, (_, c) =>
                Array.from({ length: n }, (_, i) =>
                  c % 3 === 0 ? `row ${from + i + 1}` : ((from + i) * 7 + c) / 4,
                ),
              ),
            );
          }, delayMs);
        }),
    };
    const plugin = definePlugin({
      name: '@bench/synthetic',
      displayName: 'Synthetic rows',
      contributes: [contribution(CellsDataSources, source, { id: 'synthetic' })],
    });
    const model = createCellsModel({ plugins: [plugin], limits: { rows, cols: 26 } });
    const bound = model.dispatch({
      type: 'BIND_DATA_SOURCE',
      sheet: 's1',
      source: 'synthetic',
      at: { row: 0, col: 0 },
    });
    if (!bound.ok) throw new Error(JSON.stringify(bound));
    sourced = model;
    createRoot(document.getElementById('root')!).render(
      <Spreadsheet ref={handle} model={model} aria-label="Bench" />,
    );
    // The first page in view has arrived and is painted.
    await new Promise<void>((resolve) => {
      const wait = () =>
        model.dataSourceStats().resident > 0
          ? requestAnimationFrame(() => resolve())
          : setTimeout(wait, 5);
      wait();
    });
  },
  /** Make an XLSX file of `rows` × 10 (numbers and words), written by the grid's writer, for `xlsxImport`. */
  xlsxFile(rows: number): number {
    const model = createCellsModel();
    const columns: CellValue[][] = [];
    for (let c = 0; c < 10; c += 1) {
      const col: CellValue[] = new Array(rows);
      for (let r = 0; r < rows; r += 1) col[r] = c % 3 === 0 ? `word ${r}` : (r * 7 + c) / 4;
      columns.push(col);
    }
    model.loadColumns('s1', { row: 0, col: 0 }, columns);
    xlsxFile = writeXlsx(model);
    return xlsxFile.byteLength;
  },
  /**
   * C5-02: read the file `xlsxFile` made in the XLSX worker and load it into a
   * fresh model; resolves with the time it took and the cells loaded.
   */
  async xlsxImport(): Promise<{ ms: number; cells: number }> {
    const t0 = performance.now();
    const { workbook } = await readXlsxFile(xlsxFile!);
    const model = createCellsModel({ data: workbook });
    return { ms: performance.now() - t0, cells: model.stats().cells };
  },
  /** The data source model's page counters. */
  dataSourceStats: () => sourced!.dataSourceStats(),
  handle: () => handle.current!,
};

let sourced: CellsModel | undefined;

let chained: CellsModel | undefined;
let csvFile: Blob | undefined;
let xlsxFile: Uint8Array | undefined;

/** Resolves when the model's background recalculation is over. */
function idle(model: CellsModel): Promise<void> {
  return new Promise((resolve) => {
    const wait = () =>
      model.stats().engine.calculating
        ? setTimeout(wait, 5)
        : requestAnimationFrame(() => resolve());
    wait();
  });
}

(window as unknown as { cellsBench: typeof api }).cellsBench = api;
