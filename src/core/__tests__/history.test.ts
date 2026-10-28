/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Command, CellsPatchOps, createCellsModel } from '../index.js';

describe('the forcing test: every patch op inverts', () => {
  it('finds every op of the platform, and each inverts back to itself', () => {
    const m = createCellsModel({ limits: { rows: 1000, cols: 100 } });
    const ops = m.patchOpNames();
    expect(ops.length).toBeGreaterThanOrEqual(11);
    for (const name of ops) {
      const op = m.patchOp(name)!;
      const p = op.example(m.workbook);
      const inverse = op.invert(p);
      const back = m.patchOp(inverse.op)!.invert(inverse);
      expect(back, `invert(invert(${name}))`).toEqual(p);
    }
  });

  it('refuses a plugin patch op that does not declare its inverse', () => {
    const Broken = definePlugin({
      name: '@acme/broken',
      contributes: [
        contribution(CellsPatchOps, {
          op: 'broken',
          apply: () => {},
          example: () => ({ op: 'broken' }),
        } as never),
      ],
    });
    const m = createCellsModel({ plugins: [Broken] });
    expect(() => m.patchOpNames()).toThrow(
      /@acme\/broken contributes a malformed patch op.*has no invert/,
    );
  });

  it('refuses two plugins registering one op, naming both', () => {
    const op = {
      op: 'cells',
      apply: () => {},
      invert: (p: never) => p,
      example: () => ({ op: 'cells' }),
    };
    const Clash = definePlugin({
      name: '@acme/clash',
      contributes: [contribution(CellsPatchOps, op as never)],
    });
    const m = createCellsModel({ plugins: [Clash] });
    expect(() => m.patchOpNames()).toThrow(
      /'cells' is contributed twice.*(@acme\/clash.*@datalayer\/cells-core|@datalayer\/cells-core.*@acme\/clash)/,
    );
  });
});

const ROWS = 30;
const COLS = 8;
const pos = fc.record({ row: fc.nat(ROWS - 1), col: fc.nat(COLS - 1) });
const value = fc.oneof(
  fc.integer(),
  fc.constantFrom('a', 'b', 'longer text'),
  fc.boolean(),
  fc.constant(null),
);

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    type: fc.constant('SET_CELLS'),
    sheet: fc.constant('s1'),
    at: pos,
    cells: fc.array(fc.array(value, { minLength: 1, maxLength: 3 }), {
      minLength: 1,
      maxLength: 3,
    }),
  }),
  fc.record({
    type: fc.constant('SET_STYLE'),
    sheet: fc.constant('s1'),
    zone: fc.record({
      top: fc.nat(5),
      left: fc.nat(3),
      bottom: fc.integer({ min: 5, max: 10 }),
      right: fc.integer({ min: 3, max: 6 }),
    }),
    style: fc.constantFrom({ bold: true }, { fill: '#ff0' }, null),
  }),
  fc.record({
    type: fc.constant('CLEAR'),
    sheet: fc.constant('s1'),
    zone: fc.constant({ top: 2, left: 1, bottom: 8, right: 4 }),
  }),
  fc.record({
    type: fc.constantFrom('INSERT_AXIS', 'DELETE_AXIS'),
    sheet: fc.constant('s1'),
    axis: fc.constantFrom('rows', 'cols'),
    at: fc.nat(6),
    n: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    type: fc.constant('MOVE_AXIS'),
    sheet: fc.constant('s1'),
    axis: fc.constantFrom('rows', 'cols'),
    at: fc.nat(3),
    n: fc.constant(1),
    to: fc.integer({ min: 5, max: 7 }),
  }),
  fc.record({
    type: fc.constant('RESIZE_AXIS'),
    sheet: fc.constant('s1'),
    axis: fc.constantFrom('rows', 'cols'),
    from: fc.nat(4),
    to: fc.integer({ min: 4, max: 6 }),
    size: fc.integer({ min: 5, max: 90 }),
  }),
  fc.record({
    type: fc.constant('HIDE_AXIS'),
    sheet: fc.constant('s1'),
    axis: fc.constantFrom('rows', 'cols'),
    from: fc.nat(4),
    to: fc.integer({ min: 4, max: 6 }),
    hidden: fc.boolean(),
  }),
  fc.record({
    type: fc.constant('MERGE'),
    sheet: fc.constant('s1'),
    zone: fc.record({
      top: fc.nat(10),
      left: fc.nat(4),
      bottom: fc.integer({ min: 11, max: 13 }),
      right: fc.integer({ min: 5, max: 6 }),
    }),
  }),
  fc.record({
    type: fc.constant('UNMERGE'),
    sheet: fc.constant('s1'),
    zone: fc.constant({ top: 0, left: 0, bottom: ROWS - 1, right: COLS - 1 }),
  }),
  fc.record({ type: fc.constant('ADD_SHEET') }),
  // Charts (C10-01): inserted over column A, updated, moved, resized, deleted; refusals are fine.
  fc.record({
    type: fc.constant('INSERT_CHART'),
    sheet: fc.constant('s1'),
    chart: fc.record({
      id: fc.constantFrom('c1', 'c2'),
      type: fc.constantFrom('column', 'line', 'pie'),
      anchor: fc.constant({
        kind: 'cells' as const,
        from: { row: 1, col: 4, dx: 0, dy: 0 },
        to: { row: 8, col: 7, dx: 0, dy: 0 },
      }),
      data: fc.constant({
        series: [{ values: 'Sheet1!$A$1:$A$12', categories: 'Sheet1!$B$1:$B$12' }],
        by: 'columns' as const,
        headers: { row: false, column: false },
        blanks: 'gap' as const,
      }),
      legend: fc.constantFrom('bottom' as const, 'none' as const),
    }),
  }),
  fc.record({
    type: fc.constant('UPDATE_CHART'),
    sheet: fc.constant('s1'),
    id: fc.constantFrom('c1', 'c2'),
    changes: fc.constantFrom({ type: 'area' }, { title: 'T' }, { labels: true }),
  }),
  fc.record({
    type: fc.constant('MOVE_CHART'),
    sheet: fc.constant('s1'),
    id: fc.constantFrom('c1', 'c2'),
    to: fc.record({ row: fc.nat(10), col: fc.nat(3) }),
  }),
  fc.record({
    type: fc.constant('RESIZE_CHART'),
    sheet: fc.constant('s1'),
    id: fc.constantFrom('c1', 'c2'),
    to: fc.record({ row: fc.integer({ min: 12, max: 20 }), col: fc.integer({ min: 5, max: 7 }) }),
  }),
  fc.record({
    type: fc.constant('DELETE_CHART'),
    sheet: fc.constant('s1'),
    id: fc.constantFrom('c1', 'c2'),
  }),
  fc.record({
    type: fc.constant('RENAME_SHEET'),
    sheet: fc.constant('s1'),
    name: fc.constantFrom('Main', 'Budget'),
  }),
  fc.record({
    type: fc.constant('FREEZE'),
    sheet: fc.constant('s1'),
    rows: fc.nat(3),
    cols: fc.nat(2),
  }),
);

describe('undo and redo', () => {
  it('N random commands then N undos give the initial workbook back, and N redos the final one', () => {
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 25 }), (commands) => {
        const m = createCellsModel({ limits: { rows: ROWS, cols: COLS } });
        m.dispatch({
          type: 'SET_CELLS',
          sheet: 's1',
          at: { row: 0, col: 0 },
          cells: [
            [1, 'x'],
            [true, 2],
          ],
        });
        const initial = JSON.stringify(m.toJSON());
        let applied = 0;
        for (const c of commands) if (m.dispatch(c).ok) applied += 1;
        const final = JSON.stringify(m.toJSON());
        for (let i = 0; i < applied; i += 1) m.undo();
        expect(JSON.stringify(m.toJSON())).toBe(initial);
        for (let i = 0; i < applied; i += 1) m.redo();
        expect(JSON.stringify(m.toJSON())).toBe(final);
      }),
      { numRuns: 300 },
    );
  });
});
