/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Charts resolved from the Reactor points (§3.12): the type of a chart from
 * `datalayer.cells.chartType`, the transforms of `datalayer.cells.chartOption`
 * in order, and the one renderer of `datalayer.cells.chartRenderer`. The
 * option of a chart is a pure function of its spec, its data and the theme,
 * memoised on the chart's data revision and the theme, so a chart is rebuilt
 * once per recalculation slice at most. Nothing here imports ECharts.
 *
 * @module core/chartOption
 */

import type { ReactorPlatform } from '@datalayer/reactor';
import type { CellsTheme } from '../render/theme.js';
import {
  CellsChartOptions,
  CellsChartRenderer,
  CellsChartTypes,
  type ChartOption,
  type ChartOptionTransform,
  type ChartRenderer,
  type ChartType,
  optionalContribution,
  PointTable,
  type Resolved,
} from '../points/index.js';
import type { ChartData, ChartSpec } from './charts.js';
import type { CellsModel } from './model.js';

const typeTables = new WeakMap<ReactorPlatform, PointTable<ChartType>>();
const transformTables = new WeakMap<ReactorPlatform, PointTable<ChartOptionTransform>>();

/** The chart types a platform resolves, by id; a duplicate is refused naming both plugins. */
export function chartTypeTable(reactor: ReactorPlatform): PointTable<ChartType> {
  let table = typeTables.get(reactor);
  if (table === undefined) {
    table = new PointTable(reactor, CellsChartTypes, {
      label: 'chart type',
      key: (t) => t.id,
      check: (t) => {
        if (typeof t.id !== 'string' || !/^[a-z][a-zA-Z0-9.-]*$/.test(t.id))
          throw new Error(`a chart type has an id such as 'column' or 'acme.radar'`);
        if (typeof t.option !== 'function') throw new Error(`the chart type ${t.id} has no option`);
        if (typeof t.describe !== 'function')
          throw new Error(`the chart type ${t.id} has no describe`);
        if (!Array.isArray(t.modules)) throw new Error(`the chart type ${t.id} lists its modules`);
      },
    });
    typeTables.set(reactor, table);
  }
  return table;
}

/** The option transforms a platform resolves, in `order`. */
export function chartTransformTable(reactor: ReactorPlatform): PointTable<ChartOptionTransform> {
  let table = transformTables.get(reactor);
  if (table === undefined) {
    table = new PointTable(reactor, CellsChartOptions, {
      label: 'chart option transform',
      key: (t) => t.id,
      check: (t) => {
        if (typeof t.transform !== 'function')
          throw new Error(`the chart option transform ${t.id} has no transform`);
      },
    });
    transformTables.set(reactor, table);
  }
  return table;
}

/** The chart type of an id, or `undefined` when no enabled plugin contributes it. */
export function resolveChartType(
  reactor: ReactorPlatform,
  type: string,
): Resolved<ChartType> | undefined {
  return chartTypeTable(reactor).get(type);
}

/** The one renderer of charts (`CellsChartsPlugin`'s), or `undefined`: charts draw as placeholders. */
export function chartRendererOf(reactor: ReactorPlatform): Resolved<ChartRenderer> | undefined {
  return optionalContribution(reactor, CellsChartRenderer, 'chart renderer');
}

/**
 * The option of a chart: its type's, then every transform that applies, in
 * order. Pure: a test runs it in Node with no DOM and no ECharts instance.
 */
export function chartOption(
  spec: ChartSpec,
  data: ChartData,
  theme: CellsTheme,
  type: ChartType,
  transforms: readonly ChartOptionTransform[] = [],
): ChartOption {
  let option = type.option(spec, data, theme);
  for (const t of transforms) {
    if (t.applies !== undefined && !t.applies(spec)) continue;
    option = t.transform(option, spec, theme);
  }
  return option;
}

/** The sentence a placeholder frame shows for a chart that is not drawn. */
export function chartPlaceholder(spec: ChartSpec, reason: 'not-loaded' | 'no-type'): string {
  const name = `A ${spec.type} chart`;
  return reason === 'not-loaded'
    ? `${name}: charts are not loaded`
    : `${name}: no plugin draws '${spec.type}' charts`;
}

/** What a chart draws as: an option with its type, or a placeholder sentence. */
export type ResolvedChart =
  | {
      readonly kind: 'option';
      readonly type: Resolved<ChartType>;
      readonly option: ChartOption;
      readonly data: ChartData;
      readonly description: string;
    }
  | { readonly kind: 'placeholder'; readonly text: string };

interface Memo {
  revision: number;
  theme: CellsTheme;
  platform: number;
  renderer: 'loaded' | 'not-loaded';
  resolved: ResolvedChart;
}

const memos = new WeakMap<ChartSpec, Memo>();

/**
 * A chart of a model resolved for drawing, memoised on the spec (replaced by
 * every patch), the chart's data revision, the theme and the platform
 * revision: an edit anywhere else in the workbook rebuilds nothing.
 */
export function resolveChart(
  model: CellsModel,
  sheet: string,
  id: string,
  theme: CellsTheme,
  renderer: 'loaded' | 'not-loaded' = chartRendererOf(model.reactor) === undefined
    ? 'not-loaded'
    : 'loaded',
): ResolvedChart {
  const spec = model.sheet(sheet).charts.get(id);
  if (spec === undefined) throw new Error(`No chart '${id}' on sheet '${sheet}'.`);
  const revision = model.chartRevision(sheet, id);
  const types = chartTypeTable(model.reactor);
  const platform = types.revision;
  const memo = memos.get(spec);
  if (
    memo !== undefined &&
    memo.revision === revision &&
    memo.theme === theme &&
    memo.platform === platform &&
    memo.renderer === renderer
  )
    return memo.resolved;
  let resolved: ResolvedChart;
  const type = renderer === 'loaded' ? types.get(spec.type) : undefined;
  if (type === undefined) {
    resolved = {
      kind: 'placeholder',
      text: chartPlaceholder(spec, renderer === 'loaded' ? 'no-type' : 'not-loaded'),
    };
  } else {
    const data = model.chartData(sheet, id);
    const transforms = chartTransformTable(model.reactor)
      .all()
      .map((t) => t.value);
    resolved = {
      kind: 'option',
      type,
      data,
      option: chartOption(spec, data, theme, type.value, transforms),
      description: type.value.describe(spec, data),
    };
  }
  memos.set(spec, { revision, theme, platform, renderer, resolved });
  return resolved;
}
