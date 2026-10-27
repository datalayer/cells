/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { describe, expect, it } from 'vitest';
import {
  CellsClipboard,
  createCellsModel,
  parseTSV,
  sliceFromText,
  toTSV,
  type CellsModel,
} from '../index.js';

const z = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });
const select = (m: CellsModel, top: number, left: number) =>
  m.select({
    sheet: m.selection.sheet,
    zones: [z(top, left)],
    anchor: { row: top, col: left },
    active: { row: top, col: left },
  });

function seeded() {
  const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      [1, 'two'],
      [{ formula: 'A1*2' }, true],
    ],
  });
  m.dispatch({
    type: 'SET_STYLE',
    sheet: 's1',
    zone: z(0, 0),
    style: { bold: true, fill: '#ff0' },
  });
  return m;
}

describe('copy and paste in the model', () => {
  it('pastes values, formulas and styles, as one undo step, into another model too', () => {
    const a = seeded();
    const slice = a.copy(z(0, 0, 1, 1));
    const b = createCellsModel({ limits: { rows: 50, cols: 10 } });
    select(b, 5, 3);
    expect(b.paste(slice)).toEqual({ ok: true });
    expect(b.toRows(z(5, 3, 6, 4))).toEqual([
      [1, 'two'],
      [2, true],
    ]);
    // Its relative reference moved with it, to the 1 pasted above it.
    expect(b.content('s1', 6, 3)?.formula).toBe('D6*2');
    expect(b.style('s1', 5, 3)).toEqual({ bold: true, fill: '#ff0' });
    expect(b.historyLabels.undo).toBe('Paste');
    b.undo();
    expect(b.stats().cells).toBe(0);
  });

  it('pastes values only, formats only, and transposed', () => {
    const a = seeded();
    const slice = a.copy(z(0, 0, 1, 1));
    const b = createCellsModel({ limits: { rows: 50, cols: 10 } });
    b.paste(slice, { row: 0, col: 0 }, { special: 'values' });
    expect(b.style('s1', 0, 0)).toEqual({});
    expect(b.content('s1', 1, 0)?.formula).toBeUndefined();
    b.paste(slice, { row: 0, col: 0 }, { special: 'formats' });
    expect(b.style('s1', 0, 0)).toEqual({ bold: true, fill: '#ff0' });
    expect(b.value('s1', 0, 0)).toBe(1);
    b.paste(slice, { row: 10, col: 0 }, { transpose: true });
    // Transposed, A1*2 lands right of the 1 and still reads the cell left of it.
    expect(b.content('s1', 10, 1)?.formula).toBe('A11*2');
    expect(b.toRows(z(10, 0, 11, 1))[0]).toEqual([1, 2]);
    expect(b.value('s1', 11, 0)).toBe('two');
  });

  it('moves a cut, clearing its source in the same step', () => {
    const m = seeded();
    const slice = m.copy(z(0, 0, 1, 1), { cut: true });
    expect(m.clipboardMark?.cut).toBe(true);
    m.paste(slice, { row: 0, col: 1 });
    expect(m.toRows(z(0, 0, 0, 2))).toEqual([[null, 1, 'two']]);
    expect(m.clipboardMark).toBeNull();
    m.undo();
    expect(m.toRows(z(0, 0, 0, 2))).toEqual([[1, 'two', null]]);
  });

  it("refuses a paste past the sheet's end and one that would cut a merge, changing nothing", () => {
    const m = seeded();
    const slice = m.copy(z(0, 0, 1, 1));
    expect(m.paste(slice, { row: 49, col: 0 })).toMatchObject({
      ok: false,
      refusals: [{ reason: 'OutOfBounds' }],
    });
    m.dispatch({ type: 'MERGE', sheet: 's1', zone: z(20, 0, 20, 4) });
    expect(m.paste(slice, { row: 19, col: 3 })).toMatchObject({
      ok: false,
      refusals: [{ reason: 'MergeOverlap' }],
    });
    const cut = m.copy(z(0, 0, 1, 1), { cut: true });
    expect(m.paste(cut, { row: 49, col: 0 }).ok).toBe(false);
    expect(m.value('s1', 0, 0)).toBe(1); // the cut's source is still there
  });

  it('carries merges inside the copy, and column widths of whole columns', () => {
    const m = seeded();
    m.dispatch({ type: 'MERGE', sheet: 's1', zone: z(0, 0, 0, 1) });
    m.paste(m.copy(z(0, 0, 1, 1)), { row: 10, col: 2 });
    expect(m.sheet('s1').merges).toContainEqual(z(10, 2, 10, 3));
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 0, to: 0, size: 150 });
    m.paste(m.copy(z(0, 0, 49, 0)), { row: 0, col: 5 });
    expect(m.sheet('s1').cols.sizeOf(5)).toBe(150);
  });

  it("lets a plugin's own handler travel with the cells", () => {
    const notes = new Map<string, string>();
    const Notes = definePlugin({
      name: '@acme/notes',
      contributes: [
        contribution(CellsClipboard, {
          id: 'notes',
          copy: (_c, _s, zone) =>
            notes.has(`${zone.top},${zone.left}`)
              ? notes.get(`${zone.top},${zone.left}`)
              : undefined,
          paste: (_c, _s, part, target) => {
            notes.set(`${target.top},${target.left}`, part as string);
            return [];
          },
        }),
      ],
    });
    const m = createCellsModel({ plugins: [Notes], limits: { rows: 50, cols: 10 } });
    notes.set('0,0', 'a note');
    const slice = m.copy(z(0, 0));
    expect(slice.parts.notes).toBe('a note');
    m.paste(slice, { row: 3, col: 3 });
    expect(notes.get('3,3')).toBe('a note');
  });
});

describe('tab-separated text', () => {
  it('round-trips tabs, newlines and quotes', () => {
    const rows = [
      ['a\tb', 'line\nbreak'],
      ['say "hi"', ''],
    ];
    expect(parseTSV(toTSV(rows))).toEqual(rows);
  });

  it('reads text as typing would', () => {
    const slice = sliceFromText([['12', 'TRUE', '=A1+1', 'text']]);
    expect(slice.parts.cells).toEqual([
      { r: 0, c: 0, v: 12 },
      { r: 0, c: 1, v: true },
      { r: 0, c: 2, f: 'A1+1' },
      { r: 0, c: 3, v: 'text' },
    ]);
  });
});
