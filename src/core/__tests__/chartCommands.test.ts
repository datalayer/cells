/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C10-04 (the unit part): the chart actions as Reactor commands. Insert from
 * the selection (beside it, selected), the keyboard moves and resizes by
 * one cell as commands, Delete, Show chart data (the source ranges
 * selected), Go to chart (cycling), and the chart selection as view state.
 */

import { describe, expect, it } from 'vitest';
import {
  type CellInput,
  CHART_COMMANDS_LIST,
  CellsMenuItems,
  createCellsModel,
  type Transaction,
} from '../index.js';
import { announce } from '../../react/messages.js';

const SALES: CellInput[][] = [
  ['Month', 'North', 'South'],
  ['Jan', 10, 7],
  ['Feb', 12, 9],
  ['Mar', 15, 11],
  ['Apr', 13, 14],
];

function model() {
  const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: SALES });
  return m;
}

const run = (m: ReturnType<typeof model>, id: string) =>
  m.reactor.executeCommand(`cells.chart.${id}`, { model: m });

const selectA1C5 = (m: ReturnType<typeof model>) =>
  m.select({
    sheet: 's1',
    zones: [{ top: 0, left: 0, bottom: 4, right: 2 }],
    anchor: { row: 0, col: 0 },
    active: { row: 0, col: 0 },
  });

describe('the chart commands', () => {
  it('are Reactor commands of the built-in plugin, with menu entries for insert, delete, show data and go to', () => {
    const m = model();
    const ids = m.reactor.listCommands().map((c) => c.id);
    for (const c of CHART_COMMANDS_LIST) expect(ids).toContain(c.id);
    const menu = m.reactor.getContributions(CellsMenuItems).map((c) => c.value.command);
    expect(menu).toEqual(
      expect.arrayContaining([
        'cells.chart.insert',
        'cells.chart.delete',
        'cells.chart.showData',
        'cells.chart.focusNext',
      ]),
    );
  });

  it('insert: a column chart inferred from the selection, anchored beside it, selected; refused with no number', async () => {
    const m = model();
    selectA1C5(m);
    const id = await run(m, 'insert');
    expect(id).toBe('chart1');
    expect(m.selectedChart).toBe('chart1');
    const spec = m.sheet('s1').charts.get('chart1')!;
    expect(spec.type).toBe('column');
    expect(spec.data.series.map((s) => s.values)).toEqual(['Sheet1!$B$2:$B$5', 'Sheet1!$C$2:$C$5']);
    expect(spec.anchor).toEqual({
      kind: 'cells',
      from: { row: 0, col: 4, dx: 0, dy: 0 },
      to: { row: 12, col: 10, dx: 0, dy: 0 },
    });
    m.select({
      sheet: 's1',
      zones: [{ top: 0, left: 0, bottom: 0, right: 0 }],
      anchor: { row: 0, col: 0 },
      active: { row: 0, col: 0 },
    });
    await expect(run(m, 'insertPie')).rejects.toThrow(/no number/);
  });

  it('the chart selection is view state: selecting cells clears it, a deleted chart clears it, an unknown id is refused', async () => {
    const m = model();
    selectA1C5(m);
    await run(m, 'insert');
    expect(m.selectedChart).toBe('chart1');
    selectA1C5(m);
    expect(m.selectedChart).toBeNull();
    m.selectChart('chart1');
    expect(() => m.selectChart('nope')).toThrow(/No chart 'nope'/);
    m.dispatch({ type: 'DELETE_CHART', sheet: 's1', id: 'chart1' });
    expect(m.selectedChart).toBeNull();
    await expect(run(m, 'delete')).rejects.toThrow(/No chart is selected/);
  });

  it('moves and resizes by one cell as commands, never past the sheet’s edge', async () => {
    const m = model();
    selectA1C5(m);
    await run(m, 'insert');
    const seen: Transaction[] = [];
    m.subscribe((tx) => seen.push(tx));
    await run(m, 'moveDown');
    await run(m, 'moveRight');
    expect(m.sheet('s1').charts.get('chart1')!.anchor).toMatchObject({
      from: { row: 1, col: 5 },
      to: { row: 13, col: 11 },
    });
    await run(m, 'moveUp');
    await run(m, 'moveUp'); // clamped at row 0
    expect(m.sheet('s1').charts.get('chart1')!.anchor).toMatchObject({ from: { row: 0, col: 5 } });
    await run(m, 'growDown');
    await run(m, 'shrinkLeft');
    expect(m.sheet('s1').charts.get('chart1')!.anchor).toMatchObject({
      to: { row: 13, col: 10 },
    });
    expect(seen.map((t) => t.commands[0].type)).toEqual([
      'MOVE_CHART',
      'MOVE_CHART',
      'MOVE_CHART',
      'MOVE_CHART',
      'RESIZE_CHART',
      'RESIZE_CHART',
    ]);
    expect(seen.map((t) => announce(t))).toEqual([
      'Moved the chart',
      'Moved the chart',
      'Moved the chart',
      'Moved the chart',
      'Resized the chart',
      'Resized the chart',
    ]);
    // Undo takes the moves back one by one.
    m.undo();
    expect(m.sheet('s1').charts.get('chart1')!.anchor).toMatchObject({ to: { col: 11 } });
  });

  it('an absolute chart moves and resizes by the default row and column sizes', async () => {
    const m = model();
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: {
        type: 'line',
        anchor: { kind: 'absolute', x: 100, y: 50, width: 300, height: 200 },
        data: {
          series: [{ values: 'Sheet1!$B$2:$B$5' }],
          by: 'columns',
          headers: { row: false, column: false },
          blanks: 'gap',
        },
        legend: 'none',
      },
    });
    m.selectChart('chart1');
    await run(m, 'moveLeft');
    await run(m, 'growDown');
    const s = m.sheet('s1');
    expect(m.sheet('s1').charts.get('chart1')!.anchor).toEqual({
      kind: 'absolute',
      x: 100 - s.cols.defaultSize,
      y: 50,
      width: 300,
      height: 200 + s.rows.defaultSize,
    });
  });

  it('delete removes the selected chart and says so', async () => {
    const m = model();
    selectA1C5(m);
    await run(m, 'insert');
    const seen: Transaction[] = [];
    m.subscribe((tx) => seen.push(tx));
    await run(m, 'delete');
    expect(m.sheet('s1').charts.size).toBe(0);
    expect(seen.map((t) => announce(t))).toEqual(['Deleted the chart']);
    expect(
      announce({
        label: 'INSERT_CHART',
        origin: 'local',
        patches: [],
        commands: [{ type: 'INSERT_CHART', sheet: 's1', chart: { type: 'pie' } } as never],
      }),
    ).toBe('Inserted a pie chart');
  });

  it('show chart data selects the source ranges in the grid, which clears the chart selection', async () => {
    const m = model();
    selectA1C5(m);
    await run(m, 'insert');
    const zones = await run(m, 'showData');
    expect(zones).toEqual([
      { top: 1, left: 1, bottom: 4, right: 1 },
      { top: 1, left: 0, bottom: 4, right: 0 },
      { top: 0, left: 1, bottom: 0, right: 1 },
      { top: 1, left: 2, bottom: 4, right: 2 },
      { top: 1, left: 0, bottom: 4, right: 0 },
      { top: 0, left: 2, bottom: 0, right: 2 },
    ]);
    expect(m.selection.zones).toHaveLength(6);
    expect(m.selection.active).toEqual({ row: 1, col: 1 });
    expect(m.selectedChart).toBeNull();
  });

  it('go to chart cycles through the sheet’s charts, and is refused on a sheet without one', async () => {
    const m = model();
    await expect(run(m, 'focusNext')).rejects.toThrow(/no chart/);
    selectA1C5(m);
    await run(m, 'insert');
    selectA1C5(m);
    await run(m, 'insertLine');
    expect(m.selectedChart).toBe('chart2');
    expect(await run(m, 'focusNext')).toBe('chart1');
    expect(await run(m, 'focusNext')).toBe('chart2');
    m.selectChart(null);
    expect(await run(m, 'focusNext')).toBe('chart1');
  });
});
