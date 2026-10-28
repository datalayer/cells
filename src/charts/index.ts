/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@datalayer/cells/charts`: charts drawn with Apache ECharts (§3.12).
 * `CellsChartsPlugin` is a lazy Reactor plugin: listed by a host, it costs
 * nothing until a chart is drawn (the first read of
 * `datalayer.cells.chartType` or `datalayer.cells.chartRenderer`), when its
 * module, the only one reaching `echarts/core`, is fetched. `echarts` and
 * `echarts-for-react` are optional peers. Without the plugin, a chart draws
 * as a labelled placeholder frame.
 *
 * @module charts
 */

import { defineLazyPlugin, onContributionPoint } from '@datalayer/reactor';
import { CellsChartRenderer, CellsChartTypes } from '../points/index.js';

export { CellsChart, type CellsChartProps } from './CellsChart.js';
export { chartName, describeChart } from './describe.js';
export {
  areaOption,
  barOption,
  baseOption,
  columnOption,
  comboOption,
  lineOption,
  pieOption,
  scatterOption,
} from './options.js';
export { chartData } from '../core/charts.js';
export {
  chartOption,
  chartPlaceholder,
  chartRendererOf,
  chartTransformTable,
  chartTypeTable,
  resolveChart,
  resolveChartType,
  type ResolvedChart,
} from '../core/chartOption.js';
export { ChartFrame, chartLabel, type ChartFrameProps } from '../react/ChartFrame.js';

export const CELLS_CHARTS_PLUGIN = '@datalayer/cells-charts';

/**
 * The charts plugin, fetched when a chart is first drawn or inserted. A
 * host adds it to its plugins (or to `<Cells plugins>`); the built-in types
 * and the ECharts renderer arrive through it.
 */
export const CellsChartsPlugin = defineLazyPlugin({
  name: CELLS_CHARTS_PLUGIN,
  displayName: 'Cells charts',
  description: 'Column, bar, line, area, pie, scatter and combo charts, drawn with Apache ECharts.',
  octicon: 'graph',
  activationEvents: [onContributionPoint(CellsChartTypes), onContributionPoint(CellsChartRenderer)],
  load: () => import('./plugin.js'),
});

// The module itself (`./plugin.js`: the built-in types, their ECharts
// modules and the renderer) is reached by `load` only, so this entry's
// static graph carries no ECharts (`bundle.charts.kB`, §4).
