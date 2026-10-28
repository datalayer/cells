/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The module `CellsChartsPlugin` loads (§3.12): the seven built-in chart
 * types through `datalayer.cells.chartType`, and the ECharts renderer
 * through `datalayer.cells.chartRenderer`. This is the only module of the
 * package that reaches `echarts/core`.
 *
 * @module charts/plugin
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { CellsChartRenderer, CellsChartTypes } from '../points/index.js';
import { EChartsRenderer } from './EChartsRenderer.js';
import { BUILTIN_CHART_TYPE_CONTRIBUTIONS } from './types.js';

export const CELLS_CHARTS_PLUGIN = '@datalayer/cells-charts';

export const CellsChartsPluginModule = definePlugin({
  name: CELLS_CHARTS_PLUGIN,
  displayName: 'Cells charts',
  description: 'Column, bar, line, area, pie, scatter and combo charts, drawn with Apache ECharts.',
  octicon: 'graph',
  contributes: [
    ...BUILTIN_CHART_TYPE_CONTRIBUTIONS.map((t) =>
      contribution(CellsChartTypes, t, { id: t.id, order: 100 }),
    ),
    contribution(
      CellsChartRenderer,
      { id: 'echarts', component: EChartsRenderer },
      { id: 'echarts', order: 100 },
    ),
  ],
});

export default CellsChartsPluginModule;
