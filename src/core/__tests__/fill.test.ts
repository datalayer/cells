/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { type CellValue, createCellsModel, FILL_RULES } from '../index.js';

const rule = (id: string) => FILL_RULES.find((r) => r.id === id)!;
/** The first `n` values a rule extends a source with, forwards (or backwards with a negative n). */
function extend(id: string, values: CellValue[], n: number, format?: string): CellValue[] {
  const series = rule(id).match(values.map((value) => ({ value, format })));
  expect(series, `${id} matches ${JSON.stringify(values)}`).toBeDefined();
  return n > 0
    ? Array.from({ length: n }, (_, i) => rule(id).next(series, i))
    : Array.from({ length: -n }, (_, i) => rule(id).next(series, -1 - i));
}

describe('the series rules', () => {
  it('numbers: the step of the source, its linear trend for more than two', () => {
    expect(extend('numbers', [1, 3], 3)).toEqual([5, 7, 9]);
    expect(extend('numbers', [10, 20, 31], 1)).toEqual([41.3333333333]);
    expect(extend('numbers', [5, 4], -2)).toEqual([6, 7]);
    expect(rule('numbers').match([{ value: 1 }])).toBeUndefined(); // one number is copied, as Excel does
  });

  it('dates: a day apart, or the step between two', () => {
    expect(extend('dates', [45000], 3, 'yyyy-mm-dd')).toEqual([45001, 45002, 45003]);
    expect(extend('dates', [45000, 45007], 2, 'd mmm')).toEqual([45014, 45021]);
    expect(rule('dates').match([{ value: 45000, format: '0.00' }])).toBeUndefined();
  });

  it('weekdays: names and short names, in their case, round the week', () => {
    expect(extend('weekdays', ['Friday'], 3)).toEqual(['Saturday', 'Sunday', 'Monday']);
    expect(extend('weekdays', ['mon', 'wed'], 2)).toEqual(['fri', 'sun']);
    expect(extend('weekdays', ['TUE'], -1)).toEqual(['MON']);
  });

  it('months: names round the year', () => {
    expect(extend('months', ['November'], 3)).toEqual(['December', 'January', 'February']);
    expect(extend('months', ['Jan', 'Apr'], 1)).toEqual(['Jul']);
  });

  it('numbered text: Item 1 → Item 2, keeping leading zeros', () => {
    expect(extend('numberedText', ['Item 1'], 2)).toEqual(['Item 2', 'Item 3']);
    expect(extend('numberedText', ['Q01', 'Q03'], 1)).toEqual(['Q05']);
    expect(rule('numberedText').match([{ value: 'A1' }, { value: 'B2' }])).toBeUndefined();
  });

  it('copy: the source repeated, as the last resort', () => {
    expect(extend('copy', ['x', 1], 5)).toEqual(['x', 1, 'x', 1, 'x']);
    expect(FILL_RULES[FILL_RULES.length - 1].id).toBe('copy');
  });
});

describe('FILL and SORT', () => {
  it('fills down, up, right and left, styles following their source, in one undo step', () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 5, col: 0 },
      cells: [
        [1, 'Mon'],
        [2, 'Tue'],
      ],
    });
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 5, left: 0, bottom: 5, right: 0 },
      style: { bold: true },
    });
    const source = { top: 5, left: 0, bottom: 6, right: 1 };
    expect(
      m.dispatch({ type: 'FILL', sheet: 's1', source, target: { ...source, bottom: 9 } }).ok,
    ).toBe(true);
    expect(m.toRows({ top: 7, left: 0, bottom: 9, right: 1 })).toEqual([
      [3, 'Wed'],
      [4, 'Thu'],
      [5, 'Fri'],
    ]);
    expect(m.style('s1', 7, 0)).toEqual({ bold: true });
    m.dispatch({ type: 'FILL', sheet: 's1', source, target: { ...source, top: 3 } });
    expect(m.toRows({ top: 3, left: 0, bottom: 4, right: 1 })).toEqual([
      [-1, 'Sat'],
      [0, 'Sun'],
    ]);
    m.undo();
    m.undo();
    expect(m.value('s1', 7, 0)).toBeNull();
    m.dispatch({
      type: 'FILL',
      sheet: 's1',
      source: { top: 5, left: 0, bottom: 5, right: 0 },
      target: { top: 5, left: 0, bottom: 5, right: 3 },
      mode: 'copy',
    });
    expect(m.toRows({ top: 5, left: 0, bottom: 5, right: 3 })).toEqual([[1, 1, 1, 1]]);
  });

  it("moves filled formulas' relative references, and refuses a fill that is not an extension", () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [[{ formula: 'B1*2' }]],
    });
    m.dispatch({
      type: 'FILL',
      sheet: 's1',
      source: { top: 0, left: 0, bottom: 0, right: 0 },
      target: { top: 0, left: 0, bottom: 2, right: 0 },
    });
    expect(m.content('s1', 2, 0)?.formula).toBe('B3*2');
    expect(
      m.dispatch({
        type: 'FILL',
        sheet: 's1',
        source: { top: 0, left: 0, bottom: 0, right: 0 },
        target: { top: 0, left: 0, bottom: 2, right: 2 },
      }),
    ).toMatchObject({
      ok: false,
      refusals: [{ reason: 'InvalidArgument' }],
    });
  });

  it("sorts rows by keys in Excel's order, empty cells last, a header kept", () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [
        ['Name', 'Score'],
        ['bob', 3],
        ['Alice', 'n/a'],
        ['carol', 1],
        ['dave', null],
        ['erin', 3],
      ],
    });
    const zone = { top: 0, left: 0, bottom: 5, right: 1 };
    expect(
      m.dispatch({
        type: 'SORT',
        sheet: 's1',
        zone,
        keys: [{ col: 1 }, { col: 0, descending: true }],
        header: true,
      }).ok,
    ).toBe(true);
    expect(m.toRows(zone)).toEqual([
      ['Name', 'Score'],
      ['carol', 1],
      ['erin', 3],
      ['bob', 3],
      ['Alice', 'n/a'],
      ['dave', null],
    ]);
    m.undo();
    m.dispatch({ type: 'SORT', sheet: 's1', zone, keys: [{ col: 0 }], header: true });
    expect(m.toRows(zone).map((r) => r[0])).toEqual([
      'Name',
      'Alice',
      'bob',
      'carol',
      'dave',
      'erin',
    ]);
  });
});
