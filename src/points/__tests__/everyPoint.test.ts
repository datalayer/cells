/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Every point exercised from outside (C7-01): the examples' `@acme/everything`
 * plugin contributes to every `datalayer.cells.*` point, a grid runs on the
 * core plugin and it alone, each contribution does what it says, and a
 * duplicate is refused at start naming both plugins.
 */

import { buildReactorFromPlugins, type ContributionPoint } from '@datalayer/reactor';
import { LoroDoc } from 'loro-crdt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACME_PLUGIN,
  AcmePlugin,
  fromRoman,
  localRooms,
  notes,
  readMarkdownTable,
  romanNumerals,
  toRoman,
  TwicePlugin,
  writeMarkdownTable,
} from '../../../examples/src/examples/plugin/acme.js';
import {
  CELLS_POINTS,
  CellsCorePlugin,
  CellsFillPlugin,
  type CellsModel,
  chartOption,
  chartTransformTable,
  createCellsModel,
  resolveChartType,
  type ChartSpec,
} from '../../core/index.js';
import { LoroBinding } from '../../collab/binding.js';
import { LIGHT_THEME } from '../../render/theme.js';
import { expectSnapshot, paint } from '../../render/__tests__/harness.js';

/** A grid on the core plugin and the third-party plugin alone: no built-in. */
function bare(): CellsModel {
  const reactor = buildReactorFromPlugins([CellsCorePlugin, AcmePlugin]);
  reactor.start();
  return createCellsModel({ reactor, limits: { rows: 200_000, cols: 20 } });
}

const zone = (top: number, left: number, bottom = top, right = left) => ({
  top,
  left,
  bottom,
  right,
});

describe('the plugin reaches every point', () => {
  it('contributes to each point CellsCorePlugin declares, under its own name', () => {
    const m = bare();
    const missing = CELLS_POINTS.filter(
      (point) =>
        !m.reactor
          .getContributions(point as ContributionPoint<unknown>)
          .some((c) => c.plugin === ACME_PLUGIN),
    ).map((p) => p.id);
    expect(missing).toEqual([]);
    expect(CELLS_POINTS.length).toBe(17);
    expect(m.reactor.hasPlugin('@datalayer/cells-core')).toBe(true);
    expect(m.reactor.hasPlugin(ACME_PLUGIN)).toBe(true);
    expect(m.reactor.hasPlugin('@datalayer/cells-functions')).toBe(false);
  });

  it('is refused at start when a second plugin contributes the same function, naming both', () => {
    const reactor = buildReactorFromPlugins([CellsCorePlugin, AcmePlugin, TwicePlugin]);
    reactor.start();
    expect(() => createCellsModel({ reactor })).toThrow(
      "The function 'SHOUT' is contributed twice to datalayer.cells.function: by @acme/everything " +
        "(id 'SHOUT') and by @acme/twice (id 'SHOUT'). Disable one of the two plugins, or rename one function.",
    );
  });
});

describe('each contribution, on the bare grid', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commands and the patch op: UPPERCASE over the cells, SET_NOTE through acme.note, both undone', () => {
    const m = bare();
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [['hello', 'world']],
    });
    expect(m.commandTypes()).toContain('UPPERCASE');
    expect(m.patchOpNames()).toContain('acme.note');
    expect(m.dispatch({ type: 'UPPERCASE', sheet: 's1', zone: zone(1, 0, 1, 1) })).toEqual({
      ok: true,
    });
    expect(m.toRows(zone(1, 0, 1, 1))).toEqual([['HELLO', 'WORLD']]);
    expect(
      m.dispatch({ type: 'SET_NOTE', sheet: 's1', row: 1, col: 0, text: 'Check this' }),
    ).toEqual({ ok: true });
    expect(notes(m.workbook).get('s1:1:0')).toBe('Check this');
    expect(m.dispatch({ type: 'SET_NOTE', sheet: 's1', row: 1, col: 0, text: '  ' })).toMatchObject(
      { ok: false },
    );
    m.undo();
    expect(notes(m.workbook).has('s1:1:0')).toBe(false);
    m.undo();
    expect(m.toRows(zone(1, 0, 1, 1))).toEqual([['hello', 'world']]);
    // The op's own inverse, as the forcing test checks it.
    const op = m.patchOp('acme.note')!;
    const p = op.example(m.workbook);
    expect(op.invert(op.invert(p))).toEqual(p);
  });

  it('functions: SHOUT at once, ECHO as #BUSY! then its value; no built-in function is there', async () => {
    const m = bare();
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [
        ['quiet', { formula: 'SHOUT(A2)' }, { formula: 'ECHO(A2)' }, { formula: 'SUM(1,2)' }],
      ],
    });
    expect(m.functionNames()).toEqual(['ECHO', 'SHOUT']);
    expect(m.value('s1', 1, 1)).toBe('QUIET');
    expect(m.value('s1', 1, 2)).toMatchObject({ error: '#BUSY!' });
    expect(m.value('s1', 1, 3)).toMatchObject({ error: '#NAME?' });
    await vi.advanceTimersByTimeAsync(600);
    expect(m.value('s1', 1, 2)).toBe('quiet…quiet');
  });

  it('the cell type, the render layer and the fill rule', async () => {
    const m = bare();
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [['loud', 'I', 'II']],
    });
    m.dispatch({ type: 'SET_STYLE', sheet: 's1', zone: zone(1, 0), style: { type: 'megaphone' } });
    expect(m.cellType('s1', 1, 0)).toMatchObject({ plugin: ACME_PLUGIN, id: 'megaphone' });
    expect(m.cellType('s1', 1, 0)!.value.accessibleName!('loud', {})).toBe('Shouted: LOUD');
    expect(m.renderLayers().map((l) => l.id)).toEqual(['acme.noteMarks']);
    m.dispatch({ type: 'SET_NOTE', sheet: 's1', row: 1, col: 2, text: 'Check this' });
    // The layer draws a red corner on the noted cell, after the cells.
    await expectSnapshot(paint(m, { width: 400, height: 80 }), 'plugin-layer');
    expect(toRoman(1994)).toBe('MCMXCIV');
    expect(fromRoman('MCMXCIV')).toBe(1994);
    expect(fromRoman('IIII')).toBeUndefined();
    const series = romanNumerals.match([{ value: 'I' }, { value: 'II' }]);
    expect(series).toEqual({ first: 1, last: 2, step: 1 });
    expect(romanNumerals.next(series, 0)).toBe('III');
    expect(romanNumerals.next(series, 1)).toBe('IV');
    expect(romanNumerals.next(series, -1)).toBeNull();
    // Through the fill handle, with the built-in fill plugin beside it: the rule comes first (order 50).
    const withFill = createCellsModel({
      reactor: (() => {
        const r = buildReactorFromPlugins([CellsCorePlugin, CellsFillPlugin, AcmePlugin]);
        r.start();
        return r;
      })(),
      limits: { rows: 100, cols: 10 },
    });
    withFill.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [['I'], ['II']],
    });
    expect(
      withFill.dispatch({
        type: 'FILL',
        sheet: 's1',
        source: zone(1, 0, 2, 0),
        target: zone(1, 0, 5, 0),
      }),
    ).toEqual({ ok: true });
    expect(withFill.toRows(zone(3, 0, 5, 0))).toEqual([['III'], ['IV'], ['V']]);
  });

  it('the clipboard handler carries notes with a copy, pasted at the same offsets', () => {
    const m = createCellsModel({ plugins: [AcmePlugin], limits: { rows: 100, cols: 10 } });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 0 }, cells: [['a', 'b']] });
    m.dispatch({ type: 'SET_NOTE', sheet: 's1', row: 1, col: 1, text: 'Check this' });
    const slice = m.copy(zone(1, 0, 1, 1));
    expect(slice.parts['acme.notes']).toEqual([[0, 1, 'Check this']]);
    expect(m.paste(slice, { row: 5, col: 3 })).toEqual({ ok: true });
    expect(notes(m.workbook).get('s1:5:4')).toBe('Check this');
    expect(m.value('s1', 5, 4)).toBe('b');
    m.undo();
    expect(notes(m.workbook).has('s1:5:4')).toBe(false);
  });

  it('the importer and the exporter: a Markdown table in, a Markdown table out', async () => {
    const m = bare();
    const importer = m.reactor.getContributions(CELLS_POINTS[7])[0];
    expect(importer).toMatchObject({ plugin: ACME_PLUGIN, value: { mime: 'text/markdown' } });
    const workbook = readMarkdownTable('| Item | Qty |\n|---|---|\n| Bolt | 3 |\n| Nut | =1+1 |\n');
    expect(workbook.sheets[0].rows).toEqual({
      '0': { cells: { '0': { v: 'Item' }, '1': { v: 'Qty' } } },
      '1': { cells: { '0': { v: 'Bolt' }, '1': { v: 3 } } },
      '2': { cells: { '0': { v: 'Nut' }, '1': { f: '1+1' } } },
    });
    const read = await (importer.value as { read(input: string): Promise<unknown> }).read(
      '| x |\n| 1 |',
    );
    expect(read).toMatchObject({ version: 1 });
    const loaded = createCellsModel({ data: workbook, plugins: [AcmePlugin] });
    expect(writeMarkdownTable(loaded)).toBe(
      '| Item | Qty |\n| --- | --- |\n| Bolt | 3 |\n| Nut | 2 |\n',
    );
    const exporter = m.reactor.getContributions(CELLS_POINTS[8])[0];
    expect(exporter).toMatchObject({ plugin: ACME_PLUGIN, value: { extension: '.md' } });
  });

  it('the data source: primes bound at a cell, #BUSY! then the page', async () => {
    const m = bare();
    expect(
      m.dispatch({
        type: 'BIND_DATA_SOURCE',
        sheet: 's1',
        source: 'acme.primes',
        at: { row: 1, col: 5 },
      }),
    ).toEqual({ ok: true });
    expect(m.value('s1', 1, 6)).toMatchObject({ error: '#BUSY!' });
    await vi.advanceTimersByTimeAsync(50);
    expect(m.toRows(zone(1, 5, 5, 6))).toEqual([
      [1, 2],
      [2, 3],
      [3, 5],
      [4, 7],
      [5, 11],
    ]);
    // Sheet row 1,025 is the source's row 1,024: the second page; the 1,025th prime is 8,167.
    expect(m.value('s1', 1_025, 6)).toMatchObject({ error: '#BUSY!' });
    await vi.advanceTimersByTimeAsync(50);
    expect(m.value('s1', 1_025, 6)).toBe(8167);
  });

  it('the collaboration provider: two documents in one room converge with no server', async () => {
    vi.useRealTimers();
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const a = createCellsModel({ plugins: [AcmePlugin], limits: { rows: 50, cols: 5 } });
    const b = createCellsModel({ plugins: [AcmePlugin], limits: { rows: 50, cols: 5 } });
    const da = new LoroDoc();
    da.setPeerId(1);
    const db = new LoroDoc();
    db.setPeerId(2);
    // The first peer seeds the room; the second joins it first, then its binding adopts what the room holds.
    const ba = new LoroBinding(a, da, { peer: '1' });
    const pa = localRooms.connect(da, 'r1');
    const pb = localRooms.connect(db, 'r1');
    const bb = new LoroBinding(b, db, { peer: '2' });
    // Row 1 is the gate's header row: the peers write below it.
    expect(
      a.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 0 }, cells: [['shared']] }),
    ).toEqual({ ok: true });
    await settle();
    expect(b.value('s1', 1, 0)).toBe('shared');
    b.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 0 }, cells: [['back']] });
    await settle();
    expect(a.value('s1', 2, 0)).toBe('back');
    pa.disconnect();
    b.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 3, col: 0 }, cells: [['alone']] });
    await settle();
    expect(a.content('s1', 3, 0)).toBeNull();
    pb.disconnect();
    ba.dispose();
    bb.dispose();
  });

  it('toolbar and menu items name Reactor commands the plugin registers; the gate locks the header row', async () => {
    const m = bare();
    const commands = m.reactor.listCommands().map((c) => c.id);
    expect(commands).toEqual(expect.arrayContaining(['acme.uppercase', 'acme.note']));
    expect(m.reactor.getContributions(CELLS_POINTS[11]).map((c) => c.value.command)).toEqual([
      'acme.uppercase',
      'acme.note',
    ]);
    expect(m.reactor.getContributions(CELLS_POINTS[12]).map((c) => c.value.command)).toEqual([
      'acme.uppercase',
      'acme.note',
    ]);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 0 }, cells: [['abc']] });
    m.select({
      sheet: 's1',
      zones: [zone(1, 0)],
      anchor: { row: 1, col: 0 },
      active: { row: 1, col: 0 },
    });
    await m.reactor.executeCommand('acme.uppercase', { model: m });
    expect(m.value('s1', 1, 0)).toBe('ABC');
    await m.reactor.executeCommand('acme.note', { model: m });
    expect(notes(m.workbook).get('s1:1:0')).toBe('Check this');
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [['Header']] }),
    ).toEqual({
      ok: false,
      refusals: [
        { reason: 'Gate', message: "Row 1 is Acme's header row: locked by @acme/everything." },
      ],
    });
    expect(
      m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 0 }, cells: [['fine']] }),
    ).toEqual({ ok: true });
  });

  it('the chart type and the chart option transform resolve through the chart tables', () => {
    const m = bare();
    const type = resolveChartType(m.reactor, 'acme.radar');
    expect(type).toMatchObject({ plugin: ACME_PLUGIN, id: 'acme.radar' });
    expect(resolveChartType(m.reactor, 'column')).toBeUndefined(); // no built-in types on the bare grid
    const spec: ChartSpec = {
      id: 'c1',
      type: 'acme.radar',
      title: 'Shape',
      anchor: { kind: 'absolute', x: 0, y: 0, width: 300, height: 200 },
      data: {
        series: [{ values: 'Sheet1!$B$2:$B$4' }],
        by: 'columns',
        headers: { row: false, column: false },
        blanks: 'gap',
      },
      legend: 'bottom',
    };
    const data = {
      series: [{ name: 'North', values: [1, 2, 3], categories: ['a', 'b', 'c'] }],
      categories: ['a', 'b', 'c'],
      deleted: [],
    };
    const transforms = chartTransformTable(m.reactor)
      .all()
      .map((t) => t.value);
    expect(transforms.map((t) => t.id)).toEqual(['acme.style']);
    const option = chartOption(spec, data as never, LIGHT_THEME, type!.value, transforms);
    expect(option.radar).toEqual({ indicator: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    expect(option.color).toEqual(['#cf222e', '#0969da', '#1a7f37', '#8250df']);
    expect(option.title).toEqual({ text: 'Shape', subtext: 'Acme' });
    expect(type!.value.describe(spec, data as never)).toBe(
      'A radar chart of 1 series over 3 axes.',
    );
  });
});
