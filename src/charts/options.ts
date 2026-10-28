/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The ECharts options of the seven built-in chart types (§3.12), as pure
 * functions of a spec, its data and the theme: tested in Node with no DOM
 * and no ECharts instance. The theme becomes `color`, `textStyle` and the
 * axis styles, so no ECharts theme is registered; under forced colours the
 * series carry decal patterns, so they are told apart without colour.
 *
 * @module charts/options
 */

import type { ChartAxis, ChartData, ChartSeriesData, ChartSpec } from '../core/charts.js';
import type { ChartOption } from '../points/index.js';
import type { CellsTheme } from '../render/theme.js';

type Dict = Record<string, unknown>;

/** The frame every type shares: colours, text, legend, tooltip, title, accessibility. */
export function baseOption(spec: ChartSpec, theme: CellsTheme): ChartOption {
  const legend =
    spec.legend === 'none'
      ? { show: false }
      : {
          show: true,
          [spec.legend === 'left' || spec.legend === 'right' ? 'orient' : 'x']:
            spec.legend === 'left' || spec.legend === 'right' ? 'vertical' : 'center',
          [spec.legend]: 0,
          textStyle: { color: theme.chartText },
        };
  return {
    color: [...theme.chartColors],
    backgroundColor: theme.chartBackground,
    textStyle: { color: theme.chartText, fontFamily: theme.fontFamily },
    ...(spec.title !== undefined
      ? { title: { text: spec.title, left: 'center', textStyle: { color: theme.chartText } } }
      : {}),
    legend,
    tooltip: { trigger: 'item', confine: true },
    aria: { enabled: true, decal: { show: theme.forcedColors === true } },
    animation: false,
  };
}

/** A value axis as the spec describes it. */
function valueAxis(axis: ChartAxis | undefined, theme: CellsTheme): Dict {
  return {
    type: axis?.log ? 'log' : 'value',
    ...(axis?.title !== undefined ? { name: axis.title, nameLocation: 'middle', nameGap: 28 } : {}),
    ...(axis?.min !== undefined ? { min: axis.min } : {}),
    ...(axis?.max !== undefined ? { max: axis.max } : {}),
    axisLine: { lineStyle: { color: theme.chartAxis } },
    axisLabel: { color: theme.chartAxis },
    splitLine: {
      show: axis?.gridlines !== false,
      lineStyle: { color: theme.chartGridline },
    },
  };
}

/** A category axis holding the categories (or 1…n when the chart names none). */
function categoryAxis(axis: ChartAxis | undefined, data: ChartData, theme: CellsTheme): Dict {
  const n = Math.max(0, ...data.series.map((s) => s.values.length));
  const categories =
    data.categories.length > 0
      ? [...data.categories]
      : Array.from({ length: n }, (_, i) => String(i + 1));
  return {
    type: 'category',
    data: categories,
    ...(axis?.title !== undefined ? { name: axis.title, nameLocation: 'middle', nameGap: 28 } : {}),
    axisLine: { lineStyle: { color: theme.chartAxis } },
    axisLabel: { color: theme.chartAxis },
    axisTick: { alignWithLabel: true },
    splitLine: { show: false },
  };
}

/** What every cartesian series carries: its name, its colour when the user set one, and its labels. */
function seriesBase(s: ChartSeriesData, spec: ChartSpec): Dict {
  return {
    name: s.name,
    ...(s.color !== undefined ? { itemStyle: { color: s.color } } : {}),
    ...(spec.labels ? { label: { show: true } } : {}),
  };
}

const PERCENT_FORMAT = '{value}%';

/** The values of each series as percentages of their category's total, for the percent variant. */
function percentOf(data: ChartData): (number | null)[][] {
  const n = Math.max(0, ...data.series.map((s) => s.values.length));
  const totals = Array.from({ length: n }, (_, i) =>
    data.series.reduce((sum, s) => sum + Math.abs(s.values[i] ?? 0), 0),
  );
  return data.series.map((s) =>
    Array.from({ length: n }, (_, i) => {
      const v = s.values[i] ?? null;
      if (v === null) return null;
      return totals[i] === 0 ? 0 : Math.round((Math.abs(v) / totals[i]) * 10_000) / 100;
    }),
  );
}

/** The frame of a chart whose data was deleted: an empty plot, the sentence naming the range under the title. */
function deletedOption(spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption {
  return {
    ...baseOption(spec, theme),
    legend: { show: false },
    title: {
      text: spec.title ?? '',
      subtext: `The data of this chart was deleted (${data.deleted.join(', ')})`,
      left: 'center',
      top: 'middle',
      textStyle: { color: theme.chartText },
      subtextStyle: {
        color: theme.chartText,
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize,
      },
    },
    series: [],
  };
}

type Cartesian = 'bar' | 'column' | 'line' | 'area';

/** The grid, the two axes and the series of a bar, column, line or area chart. */
function cartesianOption(kind: Cartesian, spec: ChartSpec, data: ChartData, theme: CellsTheme) {
  if (data.deleted.length > 0) return deletedOption(spec, data, theme);
  const percent = spec.variant === 'percent';
  const stacked = spec.variant === 'stacked' || percent;
  const values = percent ? percentOf(data) : data.series.map((s) => [...s.values]);
  const category = categoryAxis(spec.axes?.x, data, theme);
  const value = valueAxis(spec.axes?.y, theme);
  if (percent)
    Object.assign(value, {
      max: 100,
      axisLabel: { ...(value.axisLabel as Dict), formatter: PERCENT_FORMAT },
    });
  const series = data.series.map((s, i) => {
    const base = seriesBase(s, spec);
    if (kind === 'bar' || kind === 'column')
      return { ...base, type: 'bar', data: values[i], ...(stacked ? { stack: 'total' } : {}) };
    return {
      ...base,
      type: 'line',
      data: values[i],
      smooth: spec.variant === 'smooth',
      connectNulls: spec.data.blanks === 'connect',
      ...(kind === 'area' ? { areaStyle: {} } : {}),
      ...(kind === 'area' && stacked ? { stack: 'total' } : {}),
    };
  });
  return {
    ...baseOption(spec, theme),
    tooltip: { trigger: 'axis', confine: true },
    grid: {
      left: 48,
      right: 24,
      top: spec.title !== undefined ? 48 : 32,
      bottom: 40,
      containLabel: true,
    },
    ...(kind === 'bar'
      ? { xAxis: value, yAxis: { ...category, inverse: true } }
      : { xAxis: category, yAxis: value }),
    series,
  };
}

/** The ECharts option of a column chart: a pure function of the spec, its data and the theme. */
export const columnOption = (spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption =>
  cartesianOption('column', spec, data, theme);
/** The ECharts option of a bar chart. */
export const barOption = (spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption =>
  cartesianOption('bar', spec, data, theme);
/** The ECharts option of a line chart. */
export const lineOption = (spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption =>
  cartesianOption('line', spec, data, theme);
/** The ECharts option of an area chart. */
export const areaOption = (spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption =>
  cartesianOption('area', spec, data, theme);

/** A pie of the first series (a doughnut with the variant), one slice per category. */
export function pieOption(spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption {
  if (data.deleted.length > 0) return deletedOption(spec, data, theme);
  const s = data.series[0];
  const slices = s.values.map((v, i) => ({
    name: String(data.categories[i] ?? i + 1),
    value: v ?? 0,
  }));
  return {
    ...baseOption(spec, theme),
    series: [
      {
        name: s.name,
        type: 'pie',
        radius: spec.variant === 'doughnut' ? ['45%', '70%'] : '70%',
        data: slices,
        label: { show: spec.labels !== false, color: theme.chartText },
        ...(s.color !== undefined ? { itemStyle: { color: s.color } } : {}),
      },
    ],
  };
}

/** Scatter: each series' points as [x, y], x from its `x` range or 1…n. */
export function scatterOption(spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption {
  if (data.deleted.length > 0) return deletedOption(spec, data, theme);
  return {
    ...baseOption(spec, theme),
    grid: {
      left: 48,
      right: 24,
      top: spec.title !== undefined ? 48 : 32,
      bottom: 40,
      containLabel: true,
    },
    xAxis: valueAxis(spec.axes?.x, theme),
    yAxis: valueAxis(spec.axes?.y, theme),
    series: data.series.map((s) => ({
      ...seriesBase(s, spec),
      type: 'scatter',
      data: s.values
        .map((y, i) => [s.x?.[i] ?? i + 1, y] as [number | null, number | null])
        .filter(([x, y]) => x !== null && y !== null),
    })),
  };
}

/** Combo: each series as its own type (column, line or area), on the primary or a secondary value axis. */
export function comboOption(spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption {
  if (data.deleted.length > 0) return deletedOption(spec, data, theme);
  const secondary = data.series.some((s) => s.axis === 'secondary');
  const y = valueAxis(spec.axes?.y, theme);
  const y2 = { ...valueAxis(spec.axes?.y2, theme), splitLine: { show: false } };
  return {
    ...baseOption(spec, theme),
    tooltip: { trigger: 'axis', confine: true },
    grid: {
      left: 48,
      right: secondary ? 48 : 24,
      top: spec.title !== undefined ? 48 : 32,
      bottom: 40,
      containLabel: true,
    },
    xAxis: categoryAxis(spec.axes?.x, data, theme),
    yAxis: secondary ? [y, y2] : y,
    series: data.series.map((s) => {
      const kind = s.type ?? 'column';
      return {
        ...seriesBase(s, spec),
        type: kind === 'column' ? 'bar' : 'line',
        data: [...s.values],
        ...(kind === 'area' ? { areaStyle: {} } : {}),
        ...(kind !== 'column'
          ? { smooth: spec.variant === 'smooth', connectNulls: spec.data.blanks === 'connect' }
          : {}),
        ...(s.axis === 'secondary' ? { yAxisIndex: 1 } : {}),
      };
    }),
  };
}
