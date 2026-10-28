/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C10-03: the option of each built-in type and variant, in light, dark and
 * forced colours, as a snapshot (Node, no DOM, no ECharts instance), and the
 * frame of a chart whose data was deleted.
 */

import { describe, expect, it } from 'vitest';
import {
  type CellInput,
  type ChartSpec,
  chartData,
  chartOption,
  createCellsModel,
} from '../../core/index.js';
import { DARK_THEME, FORCED_COLORS_THEME, LIGHT_THEME } from '../../render/theme.js';
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import { BUILTIN_CHART_TYPE_CONTRIBUTIONS } from '../types.js';

const SALES: CellInput[][] = [
  ['Month', 'North', 'South'],
  ['Jan', 10, 7],
  ['Feb', 12, null],
  ['Mar', 15, 11],
  ['Apr', 13, 14],
];

const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: SALES });
const read = (s: string, r: number, c: number) => m.value(s, r, c);

const spec = (over: Partial<ChartSpec>): ChartSpec => ({
  id: 'c1',
  type: 'column',
  anchor: { kind: 'absolute', x: 0, y: 0, width: 400, height: 300 },
  data: {
    series: [
      { name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$5', categories: 'Sheet1!$A$2:$A$5' },
      { name: 'Sheet1!$C$1', values: 'Sheet1!$C$2:$C$5', type: 'line', axis: 'secondary' },
    ],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: 'gap',
  },
  title: 'Sales',
  legend: 'bottom',
  ...over,
});

const typeOf = (id: string) => BUILTIN_CHART_TYPE_CONTRIBUTIONS.find((t) => t.id === id)!;

const CASES: [string, Partial<ChartSpec>][] = [
  ['column', {}],
  ['column stacked', { variant: 'stacked' }],
  ['column percent', { variant: 'percent', legend: 'right' }],
  ['bar', { type: 'bar', legend: 'none', labels: true }],
  [
    'line',
    { type: 'line', axes: { x: { title: 'Month' }, y: { title: 'Units', min: 0, max: 20 } } },
  ],
  ['line smooth', { type: 'line', variant: 'smooth' }],
  ['area', { type: 'area' }],
  ['area stacked', { type: 'area', variant: 'stacked', legend: 'left' }],
  ['pie', { type: 'pie', legend: 'top' }],
  ['pie doughnut', { type: 'pie', variant: 'doughnut' }],
  ['scatter', { type: 'scatter', axes: { y: { log: true, gridlines: false } } }],
  ['combo', { type: 'combo' }],
];

describe('the option of each type', () => {
  for (const [name, over] of CASES) {
    for (const [mode, theme] of [
      ['light', LIGHT_THEME],
      ['dark', DARK_THEME],
      ['forced', FORCED_COLORS_THEME],
    ] as const) {
      it(`${name}, ${mode}`, () => {
        const s = spec(over);
        const data = chartData(read, m.workbook, 's1', s);
        const option = chartOption(s, data, theme, typeOf(s.type));
        expect(option).toMatchSnapshot();
        // The theme is the option's: no ECharts theme is registered.
        expect(option.color).toEqual(theme.chartColors);
        expect(option.backgroundColor).toBe(theme.chartBackground);
        expect((option.aria as { decal: { show: boolean } }).decal.show).toBe(mode === 'forced');
      });
    }
  }

  it('a chart whose data was deleted is an empty frame naming the range', () => {
    const s = spec({ data: { ...spec({}).data, series: [{ values: '#REF!', name: 'North' }] } });
    const data = chartData(read, m.workbook, 's1', s);
    const option = chartOption(s, data, LIGHT_THEME, typeOf('column'));
    expect(option.series).toEqual([]);
    expect((option.title as { subtext: string }).subtext).toBe(
      'The data of this chart was deleted (#REF!)',
    );
    expect(typeOf('column').describe(s, data)).toBe(
      'Sales. The data of this chart was deleted (#REF!).',
    );
  });

  it('describes a chart in words: its name, series and categories, each series’ range and peak', () => {
    const s = spec({ title: undefined });
    const data = chartData(read, m.workbook, 's1', s);
    expect(typeOf('column').describe(s, data)).toBe(
      'Column chart of 2 series. 2 series, 4 categories from Jan to Apr; North runs from 10 to 15, highest in Mar; South runs from 7 to 14, highest in Apr.',
    );
    const one = spec({ title: undefined, data: { ...s.data, series: [s.data.series[0]] } });
    expect(typeOf('line').describe(one, chartData(read, m.workbook, 's1', one))).toMatch(
      /^Line chart of North\. 1 series/,
    );
  });

  it('a series colour set by the user is content: it does not follow the theme', () => {
    const s = spec({});
    const coloured = {
      ...s,
      data: { ...s.data, series: [{ ...s.data.series[0], color: '#123456' }] },
    };
    const option = chartOption(
      coloured,
      chartData(read, m.workbook, 's1', coloured),
      DARK_THEME,
      typeOf('column'),
    );
    expect((option.series as { itemStyle?: { color: string } }[])[0].itemStyle).toEqual({
      color: '#123456',
    });
  });

  it('applies the transforms after the type’s option, in order, skipping those that do not apply', () => {
    const s = spec({});
    const data = chartData(read, m.workbook, 's1', s);
    const order: string[] = [];
    const option = chartOption(s, data, LIGHT_THEME, typeOf('column'), [
      {
        id: 'a',
        transform: (o) => {
          order.push('a');
          return { ...o, a: 1 };
        },
      },
      { id: 'skip', applies: (sp) => sp.type === 'pie', transform: () => ({ broken: true }) },
      {
        id: 'b',
        transform: (o) => {
          order.push('b');
          return { ...o, b: (o.a as number) + 1 };
        },
      },
    ]);
    expect(order).toEqual(['a', 'b']);
    expect(option).toMatchObject({ a: 1, b: 2 });
    expect(option.broken).toBeUndefined();
  });

  it('each built-in type registers only the modules it draws with: no radar', () => {
    const charts = {
      column: [BarChart],
      bar: [BarChart],
      line: [LineChart],
      area: [LineChart],
      pie: [PieChart],
      scatter: [ScatterChart],
      combo: [BarChart, LineChart],
    };
    for (const t of BUILTIN_CHART_TYPE_CONTRIBUTIONS) {
      expect(t.modules).not.toContain(RadarChart);
      const own = [BarChart, LineChart, PieChart, ScatterChart].filter((c) =>
        t.modules.includes(c),
      );
      expect(own).toEqual(charts[t.id as keyof typeof charts]);
    }
  });
});
