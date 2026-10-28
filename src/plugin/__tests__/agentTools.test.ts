/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The agent tools (the `cells` bundle of the reactor's `AgentTools` point):
 * each tool's command, run on a reactor as a chat host runs it, with JSON
 * in and JSON out, on the grid a host names or on the focused one.
 */

import { agentToolBundle, buildReactorFromPlugins, type ReactorPlatform } from '@datalayer/reactor';
import { afterEach, describe, expect, it } from 'vitest';
import { clearCellsCommandTarget, setCellsCommandTarget } from '../../builtins/target.js';
import { type CellInput, createCellsModel } from '../../core/index.js';
import type { CellsModel } from '../../core/model.js';
import {
  CELLS_AGENT_COMMANDS,
  CELLS_AGENT_TOOLS,
  cellsAgentToolsPlugin,
  CellsAgentToolsPlugin,
  MAX_READ_CELLS,
} from '../agentTools.js';
import { cellsShellPlugins } from '../index.js';

const SALES: CellInput[][] = [
  ['Month', 'North', 'South', 'West'],
  ['Jan', 10, 7, 4],
  ['Feb', 12, 9, 6],
  ['Mar', 15, 11, 5],
];

function grid(): CellsModel {
  const m = createCellsModel({ limits: { rows: 5000, cols: 20 } });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: SALES });
  return m;
}

/** A host's reactor holding only the tools, bound to `m`, as a chat page has. */
function host(m: CellsModel): ReactorPlatform {
  const reactor = buildReactorFromPlugins([cellsAgentToolsPlugin({ model: () => m })]);
  reactor.start();
  return reactor;
}

const run = (r: ReactorPlatform, id: string, argument?: Record<string, unknown>) =>
  r.executeCommand<Record<string, unknown> | undefined, any>(id, argument);

describe('the cells agent tools', () => {
  it('are a bundle named cells, every tool a registered command, its schemas JSON', () => {
    const r = host(grid());
    const bundle = agentToolBundle(r, 'cells');
    expect(bundle).toBe(CELLS_AGENT_TOOLS);
    expect(bundle?.toolset).toEqual([
      'cells_read_range',
      'cells_write_range',
      'cells_insert_chart',
      'cells_list_charts',
      'cells_select_range',
    ]);
    const ids = r.listCommands().map((c) => c.id);
    for (const tool of CELLS_AGENT_TOOLS.commands) expect(ids).toContain(tool.command);
    expect(JSON.parse(JSON.stringify(CELLS_AGENT_TOOLS))).toEqual(CELLS_AGENT_TOOLS);
  });

  it('reads a range, and the used range when none is given', async () => {
    const r = host(grid());
    expect(await run(r, CELLS_AGENT_COMMANDS.readRange, { range: 'B2:C3' })).toEqual({
      sheet: 'Sheet1',
      range: 'B2:C3',
      values: [
        [10, 7],
        [12, 9],
      ],
    });
    const all = await run(r, CELLS_AGENT_COMMANDS.readRange);
    expect(all.range).toBe('A1:D4');
    expect(all.values[0]).toEqual(['Month', 'North', 'South', 'West']);
    expect(all.values[3]).toEqual(['Mar', 15, 11, 5]);
  });

  it('cuts a read over the cap and says so', async () => {
    const m = grid();
    const r = host(m);
    const out = await run(r, CELLS_AGENT_COMMANDS.readRange, { range: 'A1:D1000' });
    expect(out.truncated).toBe(true);
    expect(out.fullRange).toBe('A1:D1000');
    expect(out.values.length).toBe(MAX_READ_CELLS / 4);
  });

  it('writes values and formulas from a cell, in one undo step', async () => {
    const m = grid();
    const r = host(m);
    const out = await run(r, CELLS_AGENT_COMMANDS.writeRange, {
      range: 'E1',
      values: [['Total'], ['=SUM(B2:D2)'], [null]],
    });
    expect(out).toEqual({ ok: true, sheet: 'Sheet1', range: 'E1:E3' });
    expect(m.value('s1', 0, 4)).toBe('Total');
    expect(m.value('s1', 1, 4)).toBe(21);
    m.undo();
    expect(m.value('s1', 0, 4)).toBe(null);
    await expect(
      run(r, CELLS_AGENT_COMMANDS.writeRange, { range: 'E1', values: 'x' }),
    ).rejects.toThrow(/array of rows/);
  });

  it('inserts a chart over a range, typed and titled, where it is told, and lists it', async () => {
    const m = grid();
    const r = host(m);
    const out = await run(r, CELLS_AGENT_COMMANDS.insertChart, {
      range: 'A1:D4',
      type: 'line',
      title: 'Sales by region',
      at: 'A6',
    });
    expect(out).toMatchObject({ ok: true, sheet: 'Sheet1', range: 'A1:D4', type: 'line' });
    const spec = m.sheet('s1').charts.get(out.chartId)!;
    expect(spec.type).toBe('line');
    expect(spec.title).toBe('Sales by region');
    expect(spec.data.series).toHaveLength(3);
    expect(spec.anchor).toMatchObject({ kind: 'cells', from: { row: 5, col: 0 } });
    expect(m.selectedChart).toBe(out.chartId);
    const listed = await run(r, CELLS_AGENT_COMMANDS.listCharts);
    expect(listed.charts).toEqual([
      expect.objectContaining({ id: out.chartId, type: 'line', title: 'Sales by region' }),
    ]);
    expect(listed.charts[0].ranges.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(listed))).toEqual(listed);
  });

  it('refuses a chart type it does not know, and a range without numbers', async () => {
    const r = host(grid());
    await expect(
      run(r, CELLS_AGENT_COMMANDS.insertChart, { range: 'A1:D4', type: 'radar' }),
    ).rejects.toThrow(/not a chart type/);
    await expect(run(r, CELLS_AGENT_COMMANDS.insertChart, { range: 'A1:A4' })).rejects.toThrow(
      /no number/,
    );
  });

  it('selects a range', async () => {
    const m = grid();
    const r = host(m);
    expect(await run(r, CELLS_AGENT_COMMANDS.selectRange, { range: 'B2:D4' })).toEqual({
      ok: true,
      sheet: 'Sheet1',
      range: 'B2:D4',
    });
    expect(m.selection.zones).toEqual([{ top: 1, left: 1, bottom: 3, right: 3 }]);
  });

  describe('without a model from the host', () => {
    const m = grid();
    const target = { model: m };
    afterEach(() => clearCellsCommandTarget(target));

    it('act on the focused grid, and say so when there is none', async () => {
      const r = buildReactorFromPlugins([CellsAgentToolsPlugin]);
      r.start();
      await expect(run(r, CELLS_AGENT_COMMANDS.listCharts)).rejects.toThrow(/focus a grid/);
      setCellsCommandTarget(target);
      expect((await run(r, CELLS_AGENT_COMMANDS.readRange, { range: 'A1' })).values).toEqual([
        ['Month'],
      ]);
    });

    it('come with the shell plugins', () => {
      const r = buildReactorFromPlugins(cellsShellPlugins());
      r.start();
      expect(agentToolBundle(r, 'cells')).toBe(CELLS_AGENT_TOOLS);
    });
  });
});
