/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Drawing with Apache ECharts (§3.12), the way the Datalayer ui integrates
 * it: `echarts/core` with `echarts.use` of the modules the chart's type
 * declares (registered once each, when the type is first drawn), and
 * `ReactEChartsCore` from `echarts-for-react/lib/core` with `notMerge` and
 * `lazyUpdate`. ECharts takes the device pixel ratio itself; the frame's
 * size comes from the layer, so no `window` listener is bound.
 *
 * @module charts/EChartsRenderer
 */

import * as echarts from 'echarts/core';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import type { ChartRendererProps } from '../points/index.js';

const registered = new WeakSet<object>();

/** Register with ECharts the modules not registered yet; `use` is called once per module. */
export function registerChartModules(modules: readonly unknown[]): void {
  const fresh = modules.filter(
    (m): m is object =>
      (typeof m === 'object' || typeof m === 'function') && m !== null && !registered.has(m),
  );
  if (fresh.length === 0) return;
  echarts.use(fresh as never);
  for (const m of fresh) registered.add(m);
}

export function EChartsRenderer(props: ChartRendererProps) {
  registerChartModules(props.modules);
  return (
    <ReactEChartsCore
      echarts={echarts}
      option={props.option}
      notMerge
      lazyUpdate
      style={{ width: props.width, height: props.height }}
      opts={{ renderer: 'canvas' }}
    />
  );
}
