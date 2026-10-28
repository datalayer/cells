/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The seven built-in chart types as `datalayer.cells.chartType`
 * contributions (§3.12). Each declares the ECharts modules it draws with, so
 * `echarts.use` registers only what the types resolved need: a third-party
 * radar brings `RadarChart` itself, and the built-ins never pull it.
 *
 * @module charts/types
 */

import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartData, ChartSpec } from '../core/charts.js';
import type { ChartType } from '../points/index.js';
import { chartName, describeChart } from './describe.js';
import {
  areaOption,
  barOption,
  columnOption,
  comboOption,
  lineOption,
  pieOption,
  scatterOption,
} from './options.js';

/** What every type needs: the renderer, the grid and the components the base option uses. */
export const COMMON_MODULES = [
  CanvasRenderer,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  AriaComponent,
] as const;

const type = (
  id: string,
  label: string,
  octicon: string,
  modules: readonly unknown[],
  option: ChartType['option'],
): ChartType => ({
  id,
  label,
  octicon,
  modules: [...COMMON_MODULES, ...modules],
  option,
  describe: (spec: ChartSpec, data: ChartData) =>
    `${chartName(spec, data, label)}. ${describeChart(spec, data)}`,
});

/** The built-in types, in the order a type picker lists them. */
export const BUILTIN_CHART_TYPE_CONTRIBUTIONS: readonly ChartType[] = [
  type('column', 'Column', 'graph', [BarChart], columnOption),
  type('bar', 'Bar', 'graph', [BarChart], barOption),
  type('line', 'Line', 'pulse', [LineChart], lineOption),
  type('area', 'Area', 'pulse', [LineChart], areaOption),
  type('pie', 'Pie', 'pie-chart', [PieChart], pieOption),
  type('scatter', 'Scatter', 'dot-fill', [ScatterChart], scatterOption),
  type('combo', 'Combo', 'graph', [BarChart, LineChart], comboOption),
];
