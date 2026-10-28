/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What an AI agent may do with the grid on the person's screen: its
 * commands, as tools.
 *
 * After `@datalayer/decks/plugin`: the bundle is contributed to the reactor's
 * `AgentTools` point, and a host that hands its agent the page's tools (the
 * agent-runtimes chat, `useAgentCommandTools`) reads it there. Nothing here
 * imports an agent runtime. Each tool is a thin Reactor command whose
 * argument and answer are JSON: read a range's values, write values into a
 * range, insert a chart over a range, list the charts, select a range. The
 * commands act on the grid a host names (`model`), or else on the grid that
 * last had the focus, as a command run from a palette does.
 *
 * @module plugin/agentTools
 */

import {
  type AgentToolBundle,
  AgentTools,
  contribution,
  defineAgentTools,
  definePlugin,
  type ReactorCommand,
  type ReactorPlugin,
} from '@datalayer/reactor';
import { anchorBeside } from '../builtins/charts.js';
import { cellsArgument } from '../builtins/target.js';
import {
  BUILTIN_CHART_TYPES,
  type CellInput,
  type CellValue,
  type ChartSpec,
  chartRefs,
  type CommandResult,
  inferChartData,
  parseA1,
  parseInput,
  parseZone,
  type Zone,
  zoneToA1,
} from '../core/index.js';
import type { CellsModel } from '../core/model.js';

/** The ids of the agent commands, one per tool of {@link CELLS_AGENT_TOOLS}. */
export const CELLS_AGENT_COMMANDS = {
  readRange: 'cells.agent.readRange',
  writeRange: 'cells.agent.writeRange',
  insertChart: 'cells.agent.insertChart',
  listCharts: 'cells.agent.listCharts',
  selectRange: 'cells.agent.selectRange',
} as const;

/** The most cells `cells_read_range` answers with; a bigger range is cut and says so. */
export const MAX_READ_CELLS = 2000;

const RANGE = {
  type: 'string',
  description:
    'A range in A1 notation on the sheet shown, such as `A1:D13`, or one cell such as `B3`.',
};

/**
 * The bundle: the tools, named and described for a model, and the command
 * each runs. Its id is the frontend toolset an agentspec names, `cells`.
 */
export const CELLS_AGENT_TOOLS: AgentToolBundle = defineAgentTools({
  id: 'cells',
  version: '0.0.1',
  name: 'Cells',
  description:
    "Read and write the spreadsheet on the person's screen, and chart it: the grid drawn by Datalayer Cells.",
  plugin: '@datalayer/cells',
  commands: [
    {
      name: 'cells_read_range',
      command: CELLS_AGENT_COMMANDS.readRange,
      description:
        'The values of a range of the spreadsheet shown, row by row. Without a range, the whole used range from A1, which is how to find where the data is: the answer names the sheet and the range read. Numbers are numbers, empty cells null.',
      parameters: { type: 'object', properties: { range: RANGE } },
    },
    {
      name: 'cells_write_range',
      command: CELLS_AGENT_COMMANDS.writeRange,
      description:
        'Write a block of values, row by row, from the top-left cell of a range. A text starting with = is a formula (=SUM(B2:B13)); numbers, booleans and null (an empty cell) are written as they are. One undo step.',
      parameters: {
        type: 'object',
        properties: {
          range: {
            ...RANGE,
            description:
              'Where the block starts: its top-left cell, such as `E1`, or a range whose top-left cell it is.',
          },
          values: {
            type: 'array',
            description:
              'The rows to write, each an array of cells: number, string, boolean or null.',
            items: { type: 'array', items: { type: ['number', 'string', 'boolean', 'null'] } },
          },
        },
        required: ['range', 'values'],
      },
    },
    {
      name: 'cells_insert_chart',
      command: CELLS_AGENT_COMMANDS.insertChart,
      description:
        'Insert a chart of a range into the spreadsheet shown, as the Insert chart button does: the series are read from the range (a first row of names and a first column of categories become the legend and the axis). It is drawn over the grid, beside the range unless `at` says where; the answer gives its id.',
      parameters: {
        type: 'object',
        properties: {
          range: {
            ...RANGE,
            description: 'The data to chart, headers included, such as `A1:D13`.',
          },
          type: {
            type: 'string',
            enum: [...BUILTIN_CHART_TYPES],
            description: 'The chart type; column by default.',
          },
          title: { type: 'string', description: 'The title drawn above the chart.' },
          at: {
            type: 'string',
            description:
              "The cell where the chart's top-left corner goes, such as `A15` (below the data) or `F1`.",
          },
        },
        required: ['range'],
      },
    },
    {
      name: 'cells_list_charts',
      command: CELLS_AGENT_COMMANDS.listCharts,
      description: 'The charts of the sheet shown: id, type, title and the ranges each reads.',
    },
    {
      name: 'cells_select_range',
      command: CELLS_AGENT_COMMANDS.selectRange,
      description: 'Select a range of the spreadsheet shown, to show the person the cells meant.',
      parameters: { type: 'object', properties: { range: RANGE }, required: ['range'] },
    },
  ],
});

/** What a host tells {@link cellsAgentToolsPlugin}. */
export interface CellsAgentToolsOptions {
  /**
   * The grid the tools act on, asked at each call. Without it, or when it
   * answers `undefined`, the grid that last had the focus (or was mounted last).
   */
  readonly model?: () => CellsModel | undefined;
  /** The plugin's name, when a page installs more than one. */
  readonly name?: string;
}

type Arguments = Record<string, unknown> | undefined;

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${what} is a non-empty string.`);
  return v;
};

const check = (r: CommandResult): void => {
  if (!r.ok) throw new Error(r.refusals.map((x) => x.message).join(' '));
};

/** The zone holding everything on a sheet, from A1, or `null` for an empty sheet. */
function usedZone(m: CellsModel, sheet: string): Zone | null {
  const cells = m.sheet(sheet).cells;
  let right = -1;
  let bottom = -1;
  for (const col of cells.columnIndexes()) {
    const last = cells.lastRowIn(col);
    if (last < 0) continue;
    right = Math.max(right, col);
    bottom = Math.max(bottom, last);
  }
  return right < 0 ? null : { top: 0, left: 0, bottom, right };
}

/** A cell's value as JSON: an error is its code. */
const json = (v: CellValue): string | number | boolean | null =>
  v !== null && typeof v === 'object' ? `#${v.error.replace(/^#/, '')}` : v;

/** A value written by an agent: a text with `=` is a formula, everything else as it is. */
const input = (v: unknown): CellInput => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.startsWith('=') ? parseInput(v) : v;
  throw new Error(`A cell is a number, a string, a boolean or null, not ${JSON.stringify(v)}.`);
};

/**
 * The plugin contributing {@link CELLS_AGENT_TOOLS} and registering its
 * commands. Install it in the reactor the host's chat reads (not the grid's
 * own): the commands reach the grid through `model`, or the focused one.
 */
export function cellsAgentToolsPlugin(
  options: CellsAgentToolsOptions = {},
): ReactorPlugin<Record<string, never>, unknown, unknown> {
  const grid = (id: string): CellsModel => options.model?.() ?? cellsArgument(id, undefined).model;
  const command = (
    id: string,
    name: string,
    run: (m: CellsModel, a: Record<string, unknown>) => unknown,
  ): ReactorCommand<Arguments, unknown> => ({
    id,
    name,
    category: 'Cells',
    execute: (argument: Arguments) => run(grid(id), argument ?? {}),
  });
  return definePlugin({
    name: options.name ?? CELLS_AGENT_TOOLS_PLUGIN,
    displayName: 'Cells agent tools',
    description: 'Read, write, chart and select the grid on screen, as tools an agent calls.',
    octicon: 'table',
    commands: [
      command(CELLS_AGENT_COMMANDS.readRange, 'Read a range', (m, a) => {
        const sheet = m.selection.sheet;
        const zone =
          a.range === undefined ? usedZone(m, sheet) : parseZone(text(a.range, 'The range'));
        if (zone === null) return { sheet: m.sheet(sheet).name, range: null, values: [] };
        const width = zone.right - zone.left + 1;
        const rows = Math.max(
          1,
          Math.min(zone.bottom - zone.top + 1, Math.floor(MAX_READ_CELLS / width)),
        );
        const read: Zone = { ...zone, bottom: zone.top + rows - 1 };
        return {
          sheet: m.sheet(sheet).name,
          range: zoneToA1(read),
          values: m.toRows(read, sheet).map((row) => row.map(json)),
          ...(read.bottom < zone.bottom ? { truncated: true, fullRange: zoneToA1(zone) } : {}),
        };
      }),
      command(CELLS_AGENT_COMMANDS.writeRange, 'Write values into a range', (m, a) => {
        const at = parseZone(text(a.range, 'The range'));
        if (!Array.isArray(a.values) || a.values.length === 0 || !a.values.every(Array.isArray))
          throw new Error('The values are a non-empty array of rows, each an array of cells.');
        const sheet = m.selection.sheet;
        const cells = (a.values as unknown[][]).map((row) => row.map(input));
        check(m.dispatch({ type: 'SET_CELLS', sheet, at: { row: at.top, col: at.left }, cells }));
        const width = Math.max(...cells.map((row) => row.length));
        return {
          ok: true,
          sheet: m.sheet(sheet).name,
          range: zoneToA1({
            top: at.top,
            left: at.left,
            bottom: at.top + cells.length - 1,
            right: at.left + Math.max(0, width - 1),
          }),
        };
      }),
      command(CELLS_AGENT_COMMANDS.insertChart, 'Insert a chart of a range', (m, a) => {
        const zone = parseZone(text(a.range, 'The range'));
        const type = a.type === undefined ? 'column' : text(a.type, 'The type');
        if (!(BUILTIN_CHART_TYPES as readonly string[]).includes(type))
          throw new Error(
            `'${type}' is not a chart type; there are ${BUILTIN_CHART_TYPES.join(', ')}.`,
          );
        const sheet = m.selection.sheet;
        const inferred = inferChartData(
          (r, c) => m.value(sheet, r, c),
          m.sheet(sheet).name,
          zone,
          (r, c) => /[dmy]/i.test(m.style(sheet, r, c).format ?? ''),
        );
        if (!inferred.ok) throw new Error(inferred.message);
        let anchor: ChartSpec['anchor'] = anchorBeside(m, zone);
        if (a.at !== undefined && anchor.kind === 'cells') {
          const from = parseA1(text(a.at, 'Where the chart goes'));
          const rows = anchor.to.row - anchor.from.row;
          const cols = anchor.to.col - anchor.from.col;
          anchor = {
            kind: 'cells',
            from: { row: from.row, col: from.col, dx: 0, dy: 0 },
            to: { row: from.row + rows, col: from.col + cols, dx: 0, dy: 0 },
          };
        }
        const before = new Set(m.sheet(sheet).charts.keys());
        const title = a.title === undefined ? undefined : text(a.title, 'The title');
        check(
          m.dispatch({
            type: 'INSERT_CHART',
            sheet,
            chart: {
              type,
              anchor,
              data: inferred.data,
              legend: 'bottom',
              ...(title ? { title } : {}),
            },
          }),
        );
        const id = [...m.sheet(sheet).charts.keys()].find((k) => !before.has(k));
        if (id !== undefined) m.selectChart(id);
        return { ok: true, chartId: id, sheet: m.sheet(sheet).name, range: zoneToA1(zone), type };
      }),
      command(CELLS_AGENT_COMMANDS.listCharts, 'List the charts', (m) => {
        const sheet = m.selection.sheet;
        return {
          sheet: m.sheet(sheet).name,
          charts: [...m.sheet(sheet).charts.values()].map((c) => ({
            id: c.id,
            type: c.type,
            ...(c.title ? { title: c.title } : {}),
            ranges: chartRefs(c),
          })),
        };
      }),
      command(CELLS_AGENT_COMMANDS.selectRange, 'Select a range', (m, a) => {
        const zone = parseZone(text(a.range, 'The range'));
        const sheet = m.selection.sheet;
        const corner = { row: zone.top, col: zone.left };
        m.select({ sheet, zones: [zone], anchor: corner, active: corner });
        return { ok: true, sheet: m.sheet(sheet).name, range: zoneToA1(zone) };
      }),
    ],
    contributes: [contribution(AgentTools, CELLS_AGENT_TOOLS, { id: CELLS_AGENT_TOOLS.id })],
  });
}

/** The name of the plugin {@link cellsAgentToolsPlugin} makes, by default. */
export const CELLS_AGENT_TOOLS_PLUGIN = '@datalayer/cells-agent-tools';

/** The agent tools on the focused grid: what `cellsShellPlugins()` installs. */
export const CellsAgentToolsPlugin = cellsAgentToolsPlugin();
