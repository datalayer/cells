/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C10-06: `datalayer.cells.chartType` and `datalayer.cells.chartOption`. The
 * seven built-in types come from `CellsChartsPlugin` alone; a duplicate is
 * refused naming both plugins; a disabled type's charts are placeholders and
 * back when re-enabled; the transforms apply in `order`; the lazy plugin
 * loads on the first read of a chart point.
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CHART_TYPES,
  CellsChartOptions,
  CellsChartTypes,
  type ChartSpec,
  chartRendererOf,
  chartTypeTable,
  createCellsModel,
  resolveChart,
  resolveChartType,
} from '../../core/index.js';
import { LIGHT_THEME } from '../../render/theme.js';
import { CellsChartsPlugin } from '../index.js';
import { CellsChartsPluginModule } from '../plugin.js';
import { COMMON_MODULES } from '../types.js';

const spec = (type = 'column'): Omit<ChartSpec, 'id'> & { id: string } => ({
  id: 'c1',
  type,
  anchor: { kind: 'absolute', x: 0, y: 0, width: 400, height: 300 },
  data: {
    series: [{ values: 'Sheet1!$B$2:$B$5' }],
    by: 'columns',
    headers: { row: false, column: false },
    blanks: 'gap',
  },
  legend: 'bottom',
});

function model(plugins: unknown[]) {
  const m = createCellsModel({ limits: { rows: 100, cols: 20 }, plugins: plugins as never });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'North'],
      ['Jan', 10],
      ['Feb', 12],
      ['Mar', 15],
      ['Apr', 13],
    ],
  });
  return m;
}

const Radar = definePlugin({
  name: '@acme/radar',
  contributes: [
    contribution(CellsChartTypes, {
      id: 'acme.radar',
      label: 'Radar',
      modules: [...COMMON_MODULES, { type: 'FakeRadarChart' }],
      option: () => ({ radar: true }),
      describe: () => 'A radar chart.',
    }),
  ],
});

describe('datalayer.cells.chartType', () => {
  it('the seven built-in types resolve from CellsChartsPlugin alone, and nothing without it', () => {
    const bare = model([]);
    expect([...chartTypeTable(bare.reactor).keys()]).toEqual([]);
    expect(chartRendererOf(bare.reactor)).toBeUndefined();
    const m = model([CellsChartsPluginModule]);
    expect([...chartTypeTable(m.reactor).keys()].sort()).toEqual([...BUILTIN_CHART_TYPES].sort());
    expect(resolveChartType(m.reactor, 'pie')?.plugin).toBe('@datalayer/cells-charts');
    expect(chartRendererOf(m.reactor)?.id).toBe('echarts');
  });

  it('a type contributed twice is refused naming both plugins', () => {
    const Twice = definePlugin({
      name: '@acme/twice',
      contributes: [
        contribution(CellsChartTypes, {
          id: 'pie',
          label: 'Pie again',
          modules: [],
          option: () => ({}),
          describe: () => '',
        }),
      ],
    });
    const m = model([CellsChartsPluginModule, Twice]);
    let message = '';
    try {
      chartTypeTable(m.reactor).get('pie');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/chart type 'pie' is contributed twice/);
    expect(message).toContain('@datalayer/cells-charts');
    expect(message).toContain('@acme/twice');
  });

  it('a third-party type brings its own modules; the built-ins never list them', () => {
    const m = model([CellsChartsPluginModule, Radar]);
    const radar = resolveChartType(m.reactor, 'acme.radar')!;
    expect(radar.plugin).toBe('@acme/radar');
    expect(radar.value.modules).toContainEqual({ type: 'FakeRadarChart' });
    for (const id of BUILTIN_CHART_TYPES)
      expect(resolveChartType(m.reactor, id)!.value.modules).not.toContainEqual({
        type: 'FakeRadarChart',
      });
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec('acme.radar') });
    const resolved = resolveChart(m, 's1', 'c1', LIGHT_THEME);
    expect(resolved).toMatchObject({ kind: 'option', option: { radar: true } });
  });

  it('a disabled type’s charts are placeholders, and drawn again when it is re-enabled; no plugin at all says so', () => {
    const m = model([CellsChartsPluginModule, Radar]);
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec('acme.radar') });
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: { ...spec('column'), id: 'c2' } });
    expect(resolveChart(m, 's1', 'c1', LIGHT_THEME).kind).toBe('option');
    m.reactor.disable('@acme/radar');
    expect(resolveChart(m, 's1', 'c1', LIGHT_THEME)).toEqual({
      kind: 'placeholder',
      text: "A acme.radar chart: no plugin draws 'acme.radar' charts",
    });
    expect(resolveChart(m, 's1', 'c2', LIGHT_THEME).kind).toBe('option');
    m.reactor.enable('@acme/radar');
    expect(resolveChart(m, 's1', 'c1', LIGHT_THEME).kind).toBe('option');
    const bare = model([]);
    bare.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec('column') });
    expect(resolveChart(bare, 's1', 'c1', LIGHT_THEME)).toEqual({
      kind: 'placeholder',
      text: 'A column chart: charts are not loaded',
    });
  });

  it('memoises the resolution on the spec, its data revision, the theme and the platform', () => {
    const m = model([CellsChartsPluginModule]);
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec('line') });
    const a = resolveChart(m, 's1', 'c1', LIGHT_THEME);
    expect(resolveChart(m, 's1', 'c1', LIGHT_THEME)).toBe(a);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 8, col: 8 }, cells: [[1]] }); // outside
    expect(resolveChart(m, 's1', 'c1', LIGHT_THEME)).toBe(a);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [[99]] }); // inside
    const b = resolveChart(m, 's1', 'c1', LIGHT_THEME);
    expect(b).not.toBe(a);
    expect(b.kind).toBe('option');
    if (b.kind === 'option') expect(b.data.series[0].values[0]).toBe(99);
    expect(resolveChart(m, 's1', 'c1', { ...LIGHT_THEME })).not.toBe(b);
  });

  it('the lazy plugin loads on the first read of a chart point', async () => {
    const m = model([CellsChartsPlugin]);
    expect(m.reactor.hasPlugin('@datalayer/cells-charts')).toBe(true);
    expect([...chartTypeTable(m.reactor).keys()]).toEqual([]); // the read wakes it
    await expect
      .poll(() => [...chartTypeTable(m.reactor).keys()].length, { timeout: 5000 })
      .toBe(7);
    expect(chartRendererOf(m.reactor)?.id).toBe('echarts');
  });
});

describe('datalayer.cells.chartOption', () => {
  it('every transform applies in order, after the type’s option; disabling its plugin rebuilds without it', () => {
    const House = definePlugin({
      name: '@acme/house',
      contributes: [
        contribution(
          CellsChartOptions,
          { id: 'watermark', transform: (o) => ({ ...o, watermark: 'ACME', steps: ['w'] }) },
          { order: 200 },
        ),
        contribution(
          CellsChartOptions,
          {
            id: 'first',
            transform: (o) => ({ ...o, steps: [...((o.steps as string[]) ?? []), 'f'] }),
          },
          { order: 50 },
        ),
      ],
    });
    const m = model([CellsChartsPluginModule, House]);
    m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec('column') });
    const resolved = resolveChart(m, 's1', 'c1', LIGHT_THEME);
    expect(resolved).toMatchObject({ kind: 'option', option: { watermark: 'ACME', steps: ['w'] } });
    // `first` ran first (order 50) and `watermark` (order 200) replaced its steps.
    m.reactor.disable('@acme/house');
    const plain = resolveChart(m, 's1', 'c1', LIGHT_THEME);
    expect(plain.kind).toBe('option');
    expect((plain as { option: Record<string, unknown> }).option.watermark).toBeUndefined();
  });
});
