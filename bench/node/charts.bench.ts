/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `charts.option10k.ms` (§4): the option of a 10,000-point line chart, built
 * from the model's data by the pure option builder (no DOM, no ECharts
 * instance). Lower is better; the budget is 5 ms.
 */

import { bench } from 'vitest';
import { chartOption, createCellsModel, type ChartSpec } from '../../src/core/index.js';
import { LIGHT_THEME } from '../../src/render/theme.js';
import { BUILTIN_CHART_TYPE_CONTRIBUTIONS } from '../../src/charts/types.js';

const POINTS = 10_000;
const m = createCellsModel({ limits: { rows: POINTS + 10, cols: 10 } });
const rows: (string | number)[][] = [['Day', 'Value']];
for (let i = 0; i < POINTS; i += 1)
  rows.push([`D${i + 1}`, Math.round(Math.sin(i / 50) * 1000) / 10]);
m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: rows });
const spec: ChartSpec = {
  id: 'c1',
  type: 'line',
  anchor: { kind: 'absolute', x: 0, y: 0, width: 600, height: 400 },
  data: {
    series: [
      {
        name: 'Sheet1!$B$1',
        values: `Sheet1!$B$2:$B$${POINTS + 1}`,
        categories: `Sheet1!$A$2:$A$${POINTS + 1}`,
      },
    ],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: 'gap',
  },
  legend: 'bottom',
};
m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec });
const line = BUILTIN_CHART_TYPE_CONTRIBUTIONS.find((t) => t.id === 'line')!;
const data = m.chartData('s1', 'c1');

bench('charts.option10k.ms', () => {
  chartOption(spec, data, LIGHT_THEME, line);
});
