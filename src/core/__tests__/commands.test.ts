/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { type Command, type CellsModel, createCellsModel, type RefusalReason } from '../index.js';
import { CORE_COMMANDS } from '../commands.js';

const SMALL = { rows: 100, cols: 26 };

function model(): CellsModel {
  return createCellsModel({ limits: SMALL });
}

const z = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });

/** For every core command: one accepted case, and its refusals with their reasons. */
const CASES: Record<string, { ok: Command; refused: [Command, RefusalReason][] }> = {
  SET_CELLS: {
    ok: {
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [[1, 'a', true, { formula: 'A1*2' }]],
    },
    refused: [
      [{ type: 'SET_CELLS', sheet: 'nope', at: { row: 0, col: 0 }, cells: [[1]] }, 'UnknownSheet'],
      [
        { type: 'SET_CELLS', sheet: 's1', at: { row: 99, col: 0 }, cells: [[1], [2]] },
        'OutOfBounds',
      ],
      [
        { type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[Infinity]] },
        'InvalidArgument',
      ],
      [{ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [] }, 'InvalidArgument'],
    ],
  },
  SET_STYLE: {
    ok: { type: 'SET_STYLE', sheet: 's1', zone: z(0, 0, 2, 2), style: { bold: true } },
    refused: [
      [
        { type: 'SET_STYLE', sheet: 's1', zone: z(0, 0), style: { blink: true } as never },
        'InvalidArgument',
      ],
      [{ type: 'SET_STYLE', sheet: 's1', zone: z(0, 0, 100, 0), style: null }, 'OutOfBounds'],
    ],
  },
  CLEAR: {
    ok: { type: 'CLEAR', sheet: 's1', zone: z(0, 0, 5, 5), what: 'contents' },
    refused: [
      [
        { type: 'CLEAR', sheet: 's1', zone: z(0, 0), what: 'everything' as never },
        'InvalidArgument',
      ],
    ],
  },
  INSERT_AXIS: {
    ok: { type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 2, n: 3 },
    refused: [
      [{ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 99, n: 2 }, 'OutOfBounds'],
      [{ type: 'INSERT_AXIS', sheet: 's1', axis: 'cols', at: 0, n: 0 }, 'InvalidArgument'],
    ],
  },
  DELETE_AXIS: {
    ok: { type: 'DELETE_AXIS', sheet: 's1', axis: 'cols', at: 1, n: 2 },
    refused: [[{ type: 'DELETE_AXIS', sheet: 's1', axis: 'cols', at: 25, n: 2 }, 'OutOfBounds']],
  },
  MOVE_AXIS: {
    ok: { type: 'MOVE_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2, to: 5 },
    refused: [
      [{ type: 'MOVE_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2, to: 1 }, 'InvalidArgument'],
    ],
  },
  RESIZE_AXIS: {
    ok: { type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 0, to: 3, size: 140 },
    refused: [
      [
        { type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 0, to: 0, size: -1 },
        'InvalidArgument',
      ],
    ],
  },
  HIDE_AXIS: {
    ok: { type: 'HIDE_AXIS', sheet: 's1', axis: 'rows', from: 3, to: 4, hidden: true },
    refused: [
      [
        { type: 'HIDE_AXIS', sheet: 's1', axis: 'rows', from: 99, to: 100, hidden: true },
        'OutOfBounds',
      ],
    ],
  },
  MERGE: {
    ok: { type: 'MERGE', sheet: 's1', zone: z(0, 0, 1, 1) },
    refused: [[{ type: 'MERGE', sheet: 's1', zone: z(4, 4) }, 'InvalidArgument']],
  },
  UNMERGE: {
    ok: { type: 'UNMERGE', sheet: 's1', zone: z(10, 10, 11, 11) },
    refused: [[{ type: 'UNMERGE', sheet: 's1', zone: z(40, 0, 45, 5) }, 'NoMerge']],
  },
  ADD_SHEET: {
    ok: { type: 'ADD_SHEET', name: 'Budget' },
    refused: [
      [{ type: 'ADD_SHEET', name: 'Sheet1' }, 'DuplicateSheetName'],
      [{ type: 'ADD_SHEET', name: 'a/b' }, 'InvalidSheetName'],
      [{ type: 'ADD_SHEET', at: 5 }, 'OutOfBounds'],
    ],
  },
  DELETE_SHEET: {
    ok: { type: 'DELETE_SHEET', sheet: 'other' },
    refused: [[{ type: 'DELETE_SHEET', sheet: 'nope' }, 'UnknownSheet']],
  },
  RENAME_SHEET: {
    ok: { type: 'RENAME_SHEET', sheet: 's1', name: 'Summary' },
    refused: [[{ type: 'RENAME_SHEET', sheet: 's1', name: '' }, 'InvalidSheetName']],
  },
  MOVE_SHEET: {
    ok: { type: 'MOVE_SHEET', sheet: 's1', to: 1 },
    refused: [[{ type: 'MOVE_SHEET', sheet: 's1', to: 3 }, 'OutOfBounds']],
  },
  FREEZE: {
    ok: { type: 'FREEZE', sheet: 's1', rows: 1, cols: 2 },
    refused: [[{ type: 'FREEZE', sheet: 's1', rows: -1, cols: 0 }, 'OutOfBounds']],
  },
};

/** State some cases need: a merge to unmerge, a second sheet. */
function prepared(): CellsModel {
  const m = model();
  const block = Array.from({ length: 6 }, (_, r) =>
    Array.from({ length: 6 }, (_, c) => r * 10 + c),
  );
  expect(
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: block }).ok,
  ).toBe(true);
  expect(m.dispatch({ type: 'MERGE', sheet: 's1', zone: z(10, 10, 11, 11) }).ok).toBe(true);
  expect(m.dispatch({ type: 'ADD_SHEET', name: 'Other', id: 'other' }).ok).toBe(true);
  return m;
}

describe('the core commands', () => {
  it('has a case for every core command', () => {
    expect(Object.keys(CASES).sort()).toEqual(CORE_COMMANDS.map((c) => c.type).sort());
  });

  for (const [type, { ok, refused }] of Object.entries(CASES)) {
    it(`${type} is accepted, undone and redone`, () => {
      const m = prepared();
      const before = JSON.stringify(m.toJSON());
      expect(m.dispatch(ok)).toEqual({ ok: true });
      const after = JSON.stringify(m.toJSON());
      expect(after).not.toBe(before);
      expect(m.undo()).toBe(true);
      expect(JSON.stringify(m.toJSON())).toBe(before);
      expect(m.redo()).toBe(true);
      expect(JSON.stringify(m.toJSON())).toBe(after);
    });

    it(`${type} is refused with its reasons`, () => {
      for (const [command, reason] of refused) {
        const m = prepared();
        const before = JSON.stringify(m.toJSON());
        const result = m.dispatch(command);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.refusals[0].reason).toBe(reason);
          expect(result.refusals[0].message.length).toBeGreaterThan(5);
        }
        expect(JSON.stringify(m.toJSON())).toBe(before);
      }
    });
  }

  it('refuses everything on a read-only model, and an unknown command', () => {
    const m = createCellsModel({ readOnly: true, limits: SMALL });
    expect(m.dispatch(CASES.SET_CELLS.ok)).toMatchObject({
      ok: false,
      refusals: [{ reason: 'ReadOnly' }],
    });
    expect(model().dispatch({ type: 'NOPE' })).toMatchObject({
      ok: false,
      refusals: [{ reason: 'UnknownCommand' }],
    });
  });

  it('refuses an insert that would push content off the end', () => {
    const m = model();
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 99, col: 0 }, cells: [['last']] });
    expect(
      m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 }),
    ).toMatchObject({
      ok: false,
      refusals: [{ reason: 'NotEmptyAtEnd' }],
    });
  });

  it('moves content with inserted, deleted and moved rows', () => {
    const m = model();
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [['a'], ['b'], ['c'], ['d']],
    });
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 1, n: 2 });
    expect(m.toRows(z(0, 0, 5, 0)).flat()).toEqual(['a', null, null, 'b', 'c', 'd']);
    m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 2 });
    expect(m.toRows(z(0, 0, 3, 0)).flat()).toEqual([null, 'b', 'c', 'd']);
    m.dispatch({ type: 'MOVE_AXIS', sheet: 's1', axis: 'rows', at: 3, n: 1, to: 0 });
    expect(m.toRows(z(0, 0, 3, 0)).flat()).toEqual(['d', null, 'b', 'c']);
  });

  it('keeps the top-left content of a merge, as Excel does', () => {
    const m = model();
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [['keep', 'drop']],
    });
    m.dispatch({ type: 'MERGE', sheet: 's1', zone: z(0, 0, 0, 1) });
    expect(m.toRows(z(0, 0, 0, 1))).toEqual([['keep', null]]);
    expect(m.dispatch({ type: 'MERGE', sheet: 's1', zone: z(0, 1, 1, 2) })).toMatchObject({
      ok: false,
      refusals: [{ reason: 'MergeOverlap' }],
    });
  });

  it('groups a transaction into one undo step, and rolls back when it throws', () => {
    const m = model();
    m.transact('fill', () => {
      for (let r = 0; r < 5; r += 1)
        m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: r, col: 0 }, cells: [[r]] });
    });
    expect(m.historyLabels.undo).toBe('fill');
    m.undo();
    expect(m.toRows(z(0, 0, 4, 0)).flat()).toEqual([null, null, null, null, null]);
    expect(() =>
      m.transact('broken', () => {
        m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [['x']] });
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(m.value('s1', 0, 0)).toBeNull();
    expect(m.historyLabels.undo).toBeUndefined();
  });

  it('keeps the selection with the step', () => {
    const m = model();
    m.select({
      sheet: 's1',
      zones: [z(3, 3)],
      anchor: { row: 3, col: 3 },
      active: { row: 3, col: 3 },
    });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 3, col: 3 }, cells: [[1]] });
    m.select({
      sheet: 's1',
      zones: [z(9, 9)],
      anchor: { row: 9, col: 9 },
      active: { row: 9, col: 9 },
    });
    m.undo();
    expect(m.selection.active).toEqual({ row: 3, col: 3 });
  });

  it('caps the history at its step limit', () => {
    const m = createCellsModel({ limits: SMALL, history: { steps: 3 } });
    for (let i = 0; i < 10; i += 1)
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[i]] });
    let undone = 0;
    while (m.undo()) undone += 1;
    expect(undone).toBe(3);
    expect(m.value('s1', 0, 0)).toBe(6);
  });

  it('caps the history at its byte limit', () => {
    const m = createCellsModel({ limits: SMALL, history: { bytes: 10_000 } });
    const big = 'x'.repeat(2000);
    for (let i = 0; i < 10; i += 1)
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: i, col: 0 }, cells: [[big]] });
    expect(m.stats().history.bytes).toBeLessThanOrEqual(10_000 + 5000);
    expect(m.stats().history.steps).toBeLessThan(10);
  });

  it('tells listeners what changed and where it came from', () => {
    const m = model();
    const origins: string[] = [];
    m.subscribe((tx) => origins.push(`${tx.origin}:${tx.label}`));
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[1]] });
    m.undo();
    m.redo();
    expect(origins).toEqual(['local:SET_CELLS', 'undo:SET_CELLS', 'redo:SET_CELLS']);
  });
});

describe('loadColumns', () => {
  it('fills columns with no undo step, clears the history, and tells listeners it was a load', () => {
    const m = createCellsModel({ limits: { rows: 1000, cols: 10 } });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [['typed']] });
    const origins: string[] = [];
    m.subscribe((tx) => origins.push(tx.origin));
    m.loadColumns('s1', { row: 1, col: 0 }, [
      [1, 2, 3],
      ['a', null, 'c'],
    ]);
    expect(m.toRows({ top: 0, left: 0, bottom: 3, right: 1 })).toEqual([
      ['typed', null],
      [1, 'a'],
      [2, null],
      [3, 'c'],
    ]);
    expect(m.canUndo).toBe(false);
    expect(origins).toEqual(['load']);
    expect(() => m.loadColumns('s1', { row: 999, col: 0 }, [[1, 2]])).toThrow(/do not fit/);
    expect(() => m.loadColumns('s1', { row: 0, col: 0 }, [[Infinity]])).toThrow(
      /cannot hold Infinity/,
    );
  });
});

describe('the edit buffer', () => {
  it('starts with what a cell holds, commits as typing would, and refuses with the edit kept', () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 10 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [[{ formula: 'B1*2' }, 12, '007']],
    });
    m.startEdit();
    expect(m.edit).toEqual({ sheet: 's1', row: 0, col: 0, text: '=B1*2' });
    m.cancelEdit();
    m.startEdit({ row: 0, col: 1 });
    expect(m.edit?.text).toBe('12');
    m.setEditText('TRUE');
    expect(m.commitEdit()).toEqual({ ok: true });
    expect(m.value('s1', 0, 1)).toBe(true);
    expect(m.edit).toBeNull();
    // Text that would read as a number is shown with its apostrophe, so it stays text.
    m.startEdit({ row: 0, col: 2 });
    expect(m.edit?.text).toBe("'007");
    m.cancelEdit();
    const ro = createCellsModel({ readOnly: true });
    expect(() => ro.startEdit()).toThrow(/read-only/);
    expect(() => m.setEditText('x')).toThrow(/No cell is being edited/);
  });

  it('tells edit listeners, and ends an edit whose sheet is deleted', () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 10 } });
    m.dispatch({ type: 'ADD_SHEET', name: 'Two', id: 'two' });
    m.select({
      sheet: 'two',
      zones: [{ top: 0, left: 0, bottom: 0, right: 0 }],
      anchor: { row: 0, col: 0 },
      active: { row: 0, col: 0 },
    });
    const seen: (string | null)[] = [];
    m.subscribeEdit((e) => seen.push(e === null ? null : e.text));
    m.startEdit(undefined, 'x');
    m.dispatch({ type: 'DELETE_SHEET', sheet: 'two' });
    expect(m.edit).toBeNull();
    expect(seen).toEqual(['x', null]);
  });
});
