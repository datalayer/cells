/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Cell types (C7-02): the type assignment on the style, the resolution
 * through `datalayer.cells.cellType`, and the built-in checkbox, link and
 * progress bar as the first users of the point.
 */

import { buildReactorFromPlugins, contribution, definePlugin } from '@datalayer/reactor';
import { describe, expect, it } from 'vitest';
import {
  CELL_TYPES,
  CELLS_CELL_TYPES_PLUGIN,
  CellsCellTypes,
  CellsCorePlugin,
  type CellType,
  checkStyle,
  createCellsModel,
  isChecked,
  linkHref,
  progressOf,
  type Transaction,
} from '../index.js';
import { checkbox, link, progress } from '../../builtins/cellTypes.js';

const at = (row: number, col: number) => ({ top: row, left: col, bottom: row, right: col });

function model() {
  const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      [true, 'https://datalayer.io', 0.42],
      [false, 'plain words', 2],
      [{ formula: 'A1' }, 'www.example.org', { error: '#DIV/0!' }],
    ],
  });
  for (const [col, type] of [
    [0, 'checkbox'],
    [1, 'link'],
    [2, 'progress'],
  ] as const) {
    const r = m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 0, left: col, bottom: 2, right: col },
      style: { type },
    });
    expect(r.ok).toBe(true);
  }
  return m;
}

describe('the type assignment', () => {
  it('is a style property, so it is validated, persisted and undone as one', () => {
    expect(() => checkStyle({ type: 'checkbox' })).not.toThrow();
    expect(() => checkStyle({ type: '' })).toThrow(
      'style.type: the id of a cell type, a non-empty string.',
    );
    expect(() => checkStyle({ type: 3 })).toThrow('style.type');
    const m = createCellsModel();
    expect(
      m.dispatch({ type: 'SET_STYLE', sheet: 's1', zone: at(0, 0), style: { type: '' } }),
    ).toEqual({
      ok: false,
      refusals: [
        {
          reason: 'InvalidArgument',
          message: 'style.type: the id of a cell type, a non-empty string.',
        },
      ],
    });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[true]] });
    m.dispatch({ type: 'SET_STYLE', sheet: 's1', zone: at(0, 0), style: { type: 'checkbox' } });
    expect(m.style('s1', 0, 0)).toEqual({ type: 'checkbox' });
    expect(m.toJSON().styles).toEqual([{}, { type: 'checkbox' }]);
    const again = createCellsModel({ data: m.toJSON() });
    expect(again.cellType('s1', 0, 0)?.value.id).toBe('checkbox');
    m.undo();
    expect(m.cellType('s1', 0, 0)).toBeUndefined();
  });

  it('resolves a cell to the contribution its style names, with its plugin', () => {
    const m = model();
    expect(m.cellType('s1', 0, 0)).toMatchObject({
      value: checkbox,
      plugin: CELLS_CELL_TYPES_PLUGIN,
      id: 'checkbox',
    });
    expect(m.cellType('s1', 0, 1)?.value).toBe(link);
    expect(m.cellType('s1', 0, 2)?.value).toBe(progress);
    expect(m.cellType('s1', 5, 5)).toBeUndefined();
    expect(m.cellTypeIds()).toEqual(['checkbox', 'code', 'link', 'progress']);
    expect(m.cellTypeOf('progress')?.value).toBe(progress);
    expect(CELL_TYPES.map((t) => t.id)).toEqual(['checkbox', 'link', 'progress', 'code']);
  });

  it('draws a type no plugin contributes as a plain value, and follows the plugin off and on', () => {
    const m = model();
    m.dispatch({ type: 'SET_STYLE', sheet: 's1', zone: at(1, 2), style: { type: 'acme.stars' } });
    expect(m.cellType('s1', 1, 2)).toBeUndefined();
    const changes: Transaction[] = [];
    m.subscribe((tx) => changes.push(tx));
    m.reactor.disable(CELLS_CELL_TYPES_PLUGIN);
    expect(m.cellType('s1', 0, 0)).toBeUndefined();
    expect(m.cellTypeIds()).toEqual([]);
    // The view hears of it: typed cells draw otherwise now.
    expect(changes.map((tx) => tx.origin)).toEqual(['plugins']);
    m.reactor.enable(CELLS_CELL_TYPES_PLUGIN);
    expect(m.cellType('s1', 0, 0)?.value).toBe(checkbox);
    expect(changes.map((tx) => tx.origin)).toEqual(['plugins', 'plugins']);
  });

  it('refuses a type contributed twice, naming both plugins, and a malformed one', () => {
    const Twice = definePlugin({
      name: '@acme/twice',
      contributes: [contribution(CellsCellTypes, { ...checkbox }, { id: 'checkbox' })],
    });
    expect(() => createCellsModel({ plugins: [Twice] })).toThrow(
      "The cell type 'checkbox' is contributed twice to datalayer.cells.cellType: by " +
        "@acme/twice (id 'checkbox') and by @datalayer/cells-cell-types (id 'checkbox'). " +
        'Disable one of the two plugins, or rename one cell type.',
    );
    const Bad = definePlugin({
      name: '@acme/bad',
      contributes: [
        contribution(CellsCellTypes, { id: 'stars' } as unknown as CellType, { id: 'stars' }),
      ],
    });
    expect(() => createCellsModel({ plugins: [Bad] })).toThrow(
      "@acme/bad contributes a malformed cell type (id 'stars'): the cell type 'stars' has no render",
    );
  });

  it('works with only the core plugin: no types, every cell plain', () => {
    const reactor = buildReactorFromPlugins([CellsCorePlugin]);
    reactor.start();
    const m = createCellsModel({ reactor });
    expect(m.cellTypeIds()).toEqual([]);
    m.dispatch({ type: 'SET_STYLE', sheet: 's1', zone: at(0, 0), style: { type: 'checkbox' } });
    expect(m.cellType('s1', 0, 0)).toBeUndefined();
  });
});

describe('the built-in checkbox', () => {
  it('is checked for true and for a number other than 0', () => {
    expect(isChecked(true)).toBe(true);
    expect(isChecked(1)).toBe(true);
    expect(isChecked(-2)).toBe(true);
    expect(isChecked(0)).toBe(false);
    expect(isChecked(false)).toBe(false);
    expect(isChecked('TRUE')).toBe(false);
    expect(isChecked(null)).toBe(false);
  });

  it('toggles with a SET_CELLS command: undoable, refused on a read-only workbook', () => {
    const m = model();
    expect(checkbox.activateOn).toEqual([' ']);
    const action = checkbox.activate!({ sheet: 's1', row: 0, col: 0 }, m.value('s1', 0, 0), {
      workbook: m.workbook,
      value: (s, r, c) => m.value(s, r, c),
      contributions: () => [],
    });
    expect(action).toEqual({
      command: { type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[false]] },
    });
    expect(m.dispatch((action as { command: never }).command).ok).toBe(true);
    expect(m.value('s1', 0, 0)).toBe(false);
    // A3 reads A1: it follows.
    expect(m.value('s1', 2, 0)).toBe(false);
    m.undo();
    expect(m.value('s1', 0, 0)).toBe(true);
    const ro = createCellsModel({ readOnly: true, data: m.toJSON() });
    expect(ro.dispatch((action as { command: never }).command)).toMatchObject({ ok: false });
  });

  it('names itself checked or not for a screen reader, hits around its square, and is 24 px wide', () => {
    expect(checkbox.accessibleName!(true, {})).toBe('checked');
    expect(checkbox.accessibleName!(0, {})).toBe('not checked');
    const rect = { width: 100, height: 21 };
    expect(checkbox.hitTest!({ x: 50, y: 10 }, rect)).toBe(true);
    expect(checkbox.hitTest!({ x: 5, y: 10 }, rect)).toBe(false);
    expect(checkbox.hitTest!({ x: 95, y: 10 }, rect)).toBe(false);
    // Aligned left, the square sits at the left edge.
    expect(checkbox.measure!(true, {}, () => 0)).toBe(24);
  });
});

describe('the built-in link', () => {
  it('opens http(s) and mailto URLs as they are, www. under https, and nothing else', () => {
    expect(linkHref('https://datalayer.io')).toBe('https://datalayer.io');
    expect(linkHref(' http://x.org/a b ')).toBe('http://x.org/a b');
    expect(linkHref('mailto:eric@example.org')).toBe('mailto:eric@example.org');
    expect(linkHref('www.example.org/docs')).toBe('https://www.example.org/docs');
    expect(linkHref('plain words')).toBeUndefined();
    expect(linkHref('javascript:alert(1)')).toBeUndefined();
    expect(linkHref(42)).toBeUndefined();
    expect(linkHref(null)).toBeUndefined();
  });

  it('activates on Enter into an open, names itself a link, and is as wide as its text', () => {
    expect(link.activateOn).toEqual(['Enter']);
    const ctx = { workbook: undefined as never, value: () => null, contributions: () => [] };
    expect(link.activate!({ sheet: 's1', row: 0, col: 1 }, 'https://datalayer.io', ctx)).toEqual({
      open: 'https://datalayer.io',
    });
    expect(link.activate!({ sheet: 's1', row: 1, col: 1 }, 'plain words', ctx)).toBeUndefined();
    expect(link.accessibleName!('https://datalayer.io', {})).toBe('https://datalayer.io, link');
    expect(link.accessibleName!('plain words', {})).toBe('plain words');
    expect(link.accessibleName!(null, {})).toBe('');
    expect(link.measure!('abcd', {}, (t) => t.length * 7)).toBe(34);
  });
});

describe('the built-in progress bar', () => {
  it('reads a number as a fraction of 1, clamped, and nothing else', () => {
    expect(progressOf(0.42)).toBe(0.42);
    expect(progressOf(2)).toBe(1);
    expect(progressOf(-1)).toBe(0);
    expect(progressOf(Number.NaN)).toBeUndefined();
    expect(progressOf('42')).toBeUndefined();
    expect(progressOf(null)).toBeUndefined();
  });

  it('names its percentage, takes no key (the value is typed), and is 80 px wide', () => {
    expect(progress.accessibleName!(0.42, {})).toBe('42 percent');
    expect(progress.accessibleName!(1, {})).toBe('100 percent');
    expect(progress.accessibleName!('n/a', {})).toBe('n/a');
    expect(progress.activate).toBeUndefined();
    expect(progress.activateOn).toBeUndefined();
    expect(progress.measure!(0.5, {}, () => 0)).toBe(80);
    const m = model();
    // Typed: the fraction committed through the editor's path.
    m.startEdit({ row: 1, col: 2 }, '0.75');
    expect(m.commitEdit().ok).toBe(true);
    expect(m.value('s1', 1, 2)).toBe(0.75);
    expect(m.cellType('s1', 1, 2)?.value).toBe(progress);
  });
});

describe('fit columns', () => {
  it('asks a typed cell how wide it wants to be', async () => {
    const m = model();
    m.select({
      sheet: 's1',
      zones: [{ top: 0, left: 0, bottom: 0, right: 2 }],
      anchor: { row: 0, col: 0 },
      active: { row: 0, col: 0 },
    });
    await m.reactor.executeCommand('cells.fitColumns', {
      model: m,
      measure: (text: string) => text.length * 10,
    });
    const s = m.sheet('s1');
    // The checkbox column: 24 + the padding fitColumns adds; the link: its longest text; the progress: 80.
    expect(s.cols.sizeOf(0)).toBeLessThan(s.cols.sizeOf(1));
    expect(s.cols.sizeOf(1)).toBeGreaterThanOrEqual('https://datalayer.io'.length * 10);
    expect(s.cols.sizeOf(2)).toBeGreaterThanOrEqual(80);
  });
});
