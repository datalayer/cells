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
import { CellsChartsPlugin } from '@datalayer/cells/charts';
import { importCsv } from '@datalayer/cells/csv';
import { readXlsxFile, writeXlsx } from '@datalayer/cells/xlsx';
import * as echarts from 'echarts/core';
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
  /**
   * C10-10, `charts.editToPaint.ms`: a 1,000-point line chart beside its
   * values (A1:B1001), the grid mounted full window; resolves once the chart
   * is drawn.
   */
  async lineChart(points: number): Promise<void> {
    const model = createCellsModel({
      plugins: [CellsChartsPlugin],
      limits: { rows: points + 10, cols: 26 },
    });
    const rows: (string | number)[][] = [['Day', 'Value']];
    for (let i = 0; i < points; i += 1)
      rows.push([`D${i + 1}`, Math.round(Math.sin(i / 50) * 1000) / 10]);
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: rows });
    const inserted = model.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: {
        id: 'line',
        type: 'line',
        anchor: {
          kind: 'cells',
          from: { row: 1, col: 3, dx: 0, dy: 0 },
          to: { row: 21, col: 12, dx: 0, dy: 0 },
        },
        data: {
          series: [
            {
              name: 'Sheet1!$B$1',
              values: `Sheet1!$B$2:$B$${points + 1}`,
              categories: `Sheet1!$A$2:$A$${points + 1}`,
            },
          ],
          by: 'columns',
          headers: { row: true, column: true },
          blanks: 'gap',
        },
        legend: 'bottom',
      },
    });
    if (!inserted.ok) throw new Error(JSON.stringify(inserted));
    charted = model;
    createRoot(document.getElementById('root')!).render(
      <Spreadsheet ref={handle} model={model} aria-label="Bench" />,
    );
    await drawn(['line']);
  },
  /**
   * An edit inside the chart's range: `value` into B`row`, and the time from
   * the commit to the frame after ECharts has drawn an option holding it.
   */
  async chartEdit(row: number, value: number): Promise<number> {
    const model = charted!;
    const chart = instanceOf('line');
    const painted = new Promise<number>((resolve) => {
      const onRendered = () => {
        const at = performance.now();
        if (!JSON.stringify(chart.getOption()).includes(String(value))) return;
        chart.off('rendered', onRendered);
        requestAnimationFrame(() => resolve(at));
      };
      chart.on('rendered', onRendered);
    });
    const t0 = performance.now();
    model.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: row - 1, col: 1 },
      cells: [[value]],
    });
    return (await painted) - t0;
  },
  /**
   * `charts.scroll20.jsMs`: 400 rows of figures in A:D, twenty charts beside
   * them, two abreast (line and column, 50 points each), the grid mounted
   * full window; resolves once the charts in view are drawn.
   */
  async chartsSheet(count: number): Promise<number> {
    const rows = 400;
    const model = createCellsModel({
      plugins: [CellsChartsPlugin],
      limits: { rows: rows + 10, cols: 26 },
    });
    const cells: (string | number)[][] = [['Day', 'North', 'South', 'Online']];
    for (let r = 0; r < rows; r += 1)
      cells.push([
        `D${r + 1}`,
        (r * 7) % 31,
        (r * 11) % 23,
        Math.round(Math.sin(r / 9) * 100) / 10,
      ]);
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells });
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const top = 1 + Math.floor(i / 2) * 14;
      const left = 5 + (i % 2) * 8;
      const first = 2 + ((i * 17) % (rows - 50));
      const col = 'BCD'[i % 3];
      const inserted = model.dispatch({
        type: 'INSERT_CHART',
        sheet: 's1',
        chart: {
          id: `c${i}`,
          type: i % 2 === 0 ? 'line' : 'column',
          anchor: {
            kind: 'cells',
            from: { row: top, col: left, dx: 0, dy: 0 },
            to: { row: top + 12, col: left + 7, dx: 0, dy: 0 },
          },
          data: {
            series: [
              {
                name: `Sheet1!$${col}$1`,
                values: `Sheet1!$${col}$${first}:$${col}$${first + 49}`,
                categories: `Sheet1!$A$${first}:$A$${first + 49}`,
              },
            ],
            by: 'columns',
            headers: { row: false, column: false },
            blanks: 'gap',
          },
          title: `Chart ${i + 1}`,
          legend: 'none',
        },
      });
      if (!inserted.ok) throw new Error(JSON.stringify(inserted));
      ids.push(`c${i}`);
    }
    charted = model;
    createRoot(document.getElementById('root')!).render(
      <Spreadsheet ref={handle} model={model} aria-label="Bench" />,
    );
    await drawn(ids.slice(0, 2));
    return ids.length;
  },
  /** The ids of the charts drawn by ECharts right now. */
  chartsDrawn: (): string[] =>
    Array.from(document.querySelectorAll('[data-cells-chart]'))
      .filter((el) => el.querySelector('[_echarts_instance_]') !== null)
      .map((el) => el.getAttribute('data-cells-chart') ?? ''),
  /** The data source model's page counters. */
  dataSourceStats: () => sourced!.dataSourceStats(),
  handle: () => handle.current!,
};

let sourced: CellsModel | undefined;
let charted: CellsModel | undefined;

/** The ECharts instance of a chart on the page. */
function instanceOf(id: string): echarts.ECharts {
  const el = document.querySelector(`[data-cells-chart="${id}"] [_echarts_instance_]`);
  const chart = el instanceof HTMLElement ? echarts.getInstanceByDom(el) : undefined;
  if (chart === undefined) throw new Error(`The chart ${id} is not drawn by ECharts.`);
  return chart;
}

/** Resolves once each of these charts has an ECharts instance, a frame after. */
function drawn(ids: readonly string[]): Promise<void> {
  const end = performance.now() + 20_000;
  return new Promise((resolve, reject) => {
    const wait = () => {
      const missing = ids.filter(
        (id) => document.querySelector(`[data-cells-chart="${id}"] [_echarts_instance_]`) === null,
      );
      if (missing.length === 0) requestAnimationFrame(() => resolve());
      else if (performance.now() > end)
        reject(new Error(`The charts ${missing.join(', ')} were not drawn within 20 s.`));
      else setTimeout(wait, 20);
    };
    wait();
  });
}

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
