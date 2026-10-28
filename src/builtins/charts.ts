/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The chart actions as Reactor commands (§3.12, C10-04 and C10-05): insert
 * a chart from the selection, delete the selected one, move or resize it by
 * one cell (what the arrow keys do with a chart selected), show its data
 * (select its source ranges in the grid, the table a screen reader already
 * reads) and go to the next chart. Menu entries for the first four.
 *
 * @module builtins/charts
 */

import { contribution, definePlugin, type ReactorCommand } from '@datalayer/reactor';
import {
  type ChartSpec,
  chartRefs,
  inferChartData,
  refZone,
  type CommandResult,
} from '../core/index.js';
import type { CellsModel } from '../core/model.js';
import { CellsMenuItems } from '../points/index.js';
import type { Zone } from '../core/zone.js';
import type { CellsCommandArgument } from './editing.js';

export const CELLS_CHART_COMMANDS_PLUGIN = '@datalayer/cells-chart-commands';

type Action = (argument: CellsCommandArgument) => unknown;

function command(
  id: string,
  name: string,
  run: Action,
  extra: Partial<ReactorCommand<CellsCommandArgument, unknown>> = {},
): ReactorCommand<CellsCommandArgument, unknown> {
  return {
    id: `cells.chart.${id}`,
    name,
    category: 'Cells',
    ...extra,
    execute: (argument: CellsCommandArgument) => {
      if (argument === undefined || argument.model === undefined)
        throw new Error(`cells.chart.${id} runs on a grid's model: execute it with { model }.`);
      return run(argument);
    },
  };
}

const check = (r: CommandResult) => {
  if (!r.ok) throw new Error(r.refusals.map((x) => x.message).join(' '));
  return r;
};

/** The selected chart, or a sentence. */
function selected(m: CellsModel): { sheet: string; spec: ChartSpec } {
  const id = m.selectedChart;
  const sheet = m.selection.sheet;
  const spec = id === null ? undefined : m.sheet(sheet).charts.get(id);
  if (spec === undefined) throw new Error('No chart is selected: click one, or Go to chart.');
  return { sheet, spec };
}

/** Where a new chart goes: beside the selection, 12 rows by 6 columns, inside the sheet. */
export function anchorBeside(m: CellsModel, zone: Zone): ChartSpec['anchor'] {
  const s = m.sheet(m.selection.sheet);
  const col = Math.min(zone.right + 2, Math.max(0, s.cols.count - 7));
  const row = Math.min(zone.top, Math.max(0, s.rows.count - 13));
  return {
    kind: 'cells',
    from: { row, col, dx: 0, dy: 0 },
    to: { row: row + 12, col: col + 6, dx: 0, dy: 0 },
  };
}

/** Insert a chart of `type` from the last selected zone; the inserted chart is selected. */
export const insertChart =
  (type: string): Action =>
  ({ model: m }) => {
    const sheet = m.selection.sheet;
    const zone = m.selection.zones[m.selection.zones.length - 1];
    const inferred = inferChartData(
      (r, c) => m.value(sheet, r, c),
      m.sheet(sheet).name,
      zone,
      (r, c) => /[dmy]/i.test(m.style(sheet, r, c).format ?? ''),
    );
    if (!inferred.ok) throw new Error(inferred.message);
    const before = new Set(m.sheet(sheet).charts.keys());
    check(
      m.dispatch({
        type: 'INSERT_CHART',
        sheet,
        chart: { type, anchor: anchorBeside(m, zone), data: inferred.data, legend: 'bottom' },
      }),
    );
    const id = [...m.sheet(sheet).charts.keys()].find((k) => !before.has(k));
    if (id !== undefined) m.selectChart(id);
    return id;
  };

const move =
  (dr: number, dc: number): Action =>
  ({ model: m }) => {
    const { sheet, spec } = selected(m);
    const a = spec.anchor;
    if (a.kind === 'absolute') {
      const s = m.sheet(sheet);
      return check(
        m.dispatch({
          type: 'MOVE_CHART',
          sheet,
          id: spec.id,
          to: {
            x: Math.max(0, a.x + dc * s.cols.defaultSize),
            y: Math.max(0, a.y + dr * s.rows.defaultSize),
          },
        }),
      );
    }
    return check(
      m.dispatch({
        type: 'MOVE_CHART',
        sheet,
        id: spec.id,
        to: { row: Math.max(0, a.from.row + dr), col: Math.max(0, a.from.col + dc) },
      }),
    );
  };

const resize =
  (dr: number, dc: number): Action =>
  ({ model: m }) => {
    const { sheet, spec } = selected(m);
    const a = spec.anchor;
    const s = m.sheet(sheet);
    if (a.kind === 'cells')
      return check(
        m.dispatch({
          type: 'RESIZE_CHART',
          sheet,
          id: spec.id,
          to: {
            row: Math.max(a.from.row, a.to.row + dr),
            col: Math.max(a.from.col, a.to.col + dc),
          },
        }),
      );
    return check(
      m.dispatch({
        type: 'RESIZE_CHART',
        sheet,
        id: spec.id,
        to: {
          width: Math.max(16, a.width + dc * s.cols.defaultSize),
          height: Math.max(16, a.height + dr * s.rows.defaultSize),
        },
      }),
    );
  };

/** The zones a chart reads, on the chart's sheet only. */
export function sourceZones(m: CellsModel, sheet: string, spec: ChartSpec): Zone[] {
  const zones: Zone[] = [];
  for (const ref of chartRefs(spec)) {
    const r = refZone(m.workbook, sheet, ref);
    if (r !== undefined && r.sheet === sheet) zones.push(r.zone);
  }
  return zones;
}

export const CHART_COMMANDS_LIST: readonly ReactorCommand<CellsCommandArgument, unknown>[] = [
  command('insert', 'Insert chart', insertChart('column'), { octicon: 'graph' }),
  command('insertLine', 'Insert line chart', insertChart('line')),
  command('insertPie', 'Insert pie chart', insertChart('pie')),
  command('delete', 'Delete chart', ({ model: m }) => {
    const { sheet, spec } = selected(m);
    return check(m.dispatch({ type: 'DELETE_CHART', sheet, id: spec.id }));
  }),
  command('showData', 'Show chart data', ({ model: m }) => {
    const { sheet, spec } = selected(m);
    const zones = sourceZones(m, sheet, spec);
    if (zones.length === 0)
      throw new Error('The data of this chart is on another sheet, or deleted.');
    m.select({
      sheet,
      zones,
      anchor: { row: zones[0].top, col: zones[0].left },
      active: { row: zones[0].top, col: zones[0].left },
    });
    return zones;
  }),
  command('focusNext', 'Go to chart', ({ model: m }) => {
    const sheet = m.selection.sheet;
    const ids = [...m.sheet(sheet).charts.keys()];
    if (ids.length === 0) throw new Error('This sheet has no chart.');
    const i = m.selectedChart === null ? -1 : ids.indexOf(m.selectedChart);
    const next = ids[(i + 1) % ids.length];
    m.selectChart(next);
    return next;
  }),
  command('moveUp', 'Move chart up', move(-1, 0)),
  command('moveDown', 'Move chart down', move(1, 0)),
  command('moveLeft', 'Move chart left', move(0, -1)),
  command('moveRight', 'Move chart right', move(0, 1)),
  command('growDown', 'Make chart taller', resize(1, 0)),
  command('shrinkUp', 'Make chart shorter', resize(-1, 0)),
  command('growRight', 'Make chart wider', resize(0, 1)),
  command('shrinkLeft', 'Make chart narrower', resize(0, -1)),
];

export const CellsChartCommandsPlugin = definePlugin({
  name: CELLS_CHART_COMMANDS_PLUGIN,
  displayName: 'Cells chart commands',
  description: 'Insert, select, move, resize and delete charts; show their data; go to a chart.',
  octicon: 'graph',
  commands: [...CHART_COMMANDS_LIST],
  contributes: [
    ...['insert', 'delete', 'showData', 'focusNext'].map((id) =>
      contribution(CellsMenuItems, { command: `cells.chart.${id}`, group: 'charts' }, { id }),
    ),
  ],
});
