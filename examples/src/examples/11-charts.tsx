/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { createCellsModel, Spreadsheet, useCellsModel, type CellsWorkbook } from '@datalayer/cells';
import { CellsChartsPlugin } from '@datalayer/cells/charts';
import {
  AppearanceControls,
  createThemeStore,
  DatalayerThemeProvider,
  themeConfigs,
} from '@datalayer/primer-addons';
import { Frame } from '../shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NORTH = [12, 15, 14, 18, 21, 24, 27, 26, 22, 19, 16, 14];
const SOUTH = [8, 9, 11, 13, 15, 17, 19, 20, 17, 14, 11, 9];
const ONLINE = [5, 6, 7, 9, 12, 14, 16, 18, 17, 15, 12, 10];

const cell = (v: string | number) => (typeof v === 'string' ? { v } : { v });

/** Monthly figures in A1:D13, a total row under them, and four charts anchored beside them. */
type Cell = { v: string | number } | { f: string; v: number };
const rows: Record<string, { cells: Record<string, Cell> }> = {
  '0': {
    cells: { '0': cell('Month'), '1': cell('North'), '2': cell('South'), '3': cell('Online') },
  },
};
MONTHS.forEach((m, i) => {
  rows[String(i + 1)] = {
    cells: { '0': cell(m), '1': cell(NORTH[i]), '2': cell(SOUTH[i]), '3': cell(ONLINE[i]) },
  };
});
rows['13'] = {
  cells: {
    '0': cell('Total'),
    '1': { f: 'SUM(B2:B13)', v: 0 },
    '2': { f: 'SUM(C2:C13)', v: 0 },
    '3': { f: 'SUM(D2:D13)', v: 0 },
  },
};

const series = (col: string, color?: string) => ({
  name: `Figures!$${col}$1`,
  values: `Figures!$${col}$2:$${col}$13`,
  categories: 'Figures!$A$2:$A$13',
  ...(color !== undefined ? { color } : {}),
});

const anchor = (fromRow: number, fromCol: number) => ({
  kind: 'cells' as const,
  from: { row: fromRow, col: fromCol, dx: 6, dy: 4 },
  to: { row: fromRow + 12, col: fromCol + 6, dx: 0, dy: 0 },
});

/** The workbook of this page: the figures and the four charts, as `CellsWorkbook` JSON. */
export const WORKBOOK: CellsWorkbook = {
  version: 1,
  styles: [{}, { bold: true }],
  sheets: [
    {
      id: 'figures',
      name: 'Figures',
      rows: rows as CellsWorkbook['sheets'][number]['rows'],
      sizes: { rows: {}, cols: { '0': 72, '1': 64, '2': 64, '3': 64, '4': 24 } },
      charts: {
        column: {
          id: 'column',
          type: 'column',
          anchor: anchor(0, 5),
          data: {
            series: [series('B'), series('C'), series('D')],
            by: 'columns',
            headers: { row: true, column: true },
            blanks: 'gap',
          },
          title: 'Units sold, by region',
          legend: 'bottom',
          axes: { y: { title: 'Units' } },
        },
        line: {
          id: 'line',
          type: 'line',
          variant: 'smooth',
          anchor: anchor(0, 12),
          data: {
            series: [series('B'), series('C'), series('D')],
            by: 'columns',
            headers: { row: true, column: true },
            blanks: 'gap',
          },
          title: 'The year, month by month',
          legend: 'right',
        },
        pie: {
          id: 'pie',
          type: 'pie',
          variant: 'doughnut',
          anchor: anchor(14, 5),
          data: {
            series: [series('D')],
            by: 'columns',
            headers: { row: true, column: true },
            blanks: 'gap',
          },
          title: 'Online, share of the year',
          legend: 'right',
        },
        combo: {
          id: 'combo',
          type: 'combo',
          anchor: anchor(14, 12),
          data: {
            series: [
              { ...series('B'), type: 'column' },
              { ...series('C'), type: 'column' },
              { ...series('D', '#bc4c00'), type: 'line', axis: 'secondary' },
            ],
            by: 'columns',
            headers: { row: true, column: true },
            blanks: 'gap',
          },
          title: 'Regions as columns, online as a line',
          legend: 'bottom',
          axes: { y: { title: 'Regions' }, y2: { title: 'Online' } },
        },
      },
    },
  ],
};

/** The examples' appearance store, shared with the theming page. */
const useAppearance = createThemeStore('cells-examples-theme', {
  colorMode: 'auto',
  theme: 'datalayer',
});

/**
 * Charts (§3.12): four charts anchored beside twelve months of figures, drawn
 * with Apache ECharts from `@datalayer/cells/charts`, a lazy Reactor plugin.
 * Edit a value under a chart and the chart follows, once the recalculation
 * settles; the appearance chooser re-themes the charts with the grid.
 */
export default function Charts() {
  const { colorMode, theme: variant, setColorMode, setTheme } = useAppearance();
  const config = themeConfigs[variant];
  const model = useCellsModel(() =>
    createCellsModel({
      data: WORKBOOK,
      plugins: [CellsChartsPlugin],
      limits: { rows: 200, cols: 40 },
    }),
  );
  return (
    <DatalayerThemeProvider
      colorMode={colorMode}
      theme={config.primerTheme}
      themeStyles={config.themeStyles}
    >
      <div style={{ maxWidth: 420 }}>
        <AppearanceControls
          colorMode={colorMode}
          themeVariant={variant}
          onColorModeChange={setColorMode}
          onThemeChange={(v) => setTheme(v, false)}
        />
      </div>
      <p>
        A column, a line, a doughnut and a combo chart, fed by the figures on their left. Change a
        number under a chart: the chart follows the recalculation. The charts come from{' '}
        <code>@datalayer/cells/charts</code>, a lazy plugin that loads ECharts when the first chart
        is drawn; without it, each chart is a labelled placeholder.
      </p>
      <Frame height={620}>
        <Spreadsheet
          key={variant}
          model={model}
          theme={variant}
          colorMode={colorMode}
          aria-label="Figures with charts"
        />
      </Frame>
    </DatalayerThemeProvider>
  );
}
