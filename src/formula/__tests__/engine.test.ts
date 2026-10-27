/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { describe, expect, it } from 'vitest';
import {
  type CellInput,
  type CellsModel,
  CellsFunctions,
  createCellsModel,
  isCellError,
  parseFormula,
  shapeOf,
  translateFormula,
  transposeFormula,
} from '../../core/index.js';

const z = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });

function model(rows: CellInput[][], options: Parameters<typeof createCellsModel>[0] = {}) {
  const m = createCellsModel({ limits: { rows: 200_000, cols: 20 }, ...options });
  if (rows.length > 0)
    expect(
      m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: rows }),
    ).toEqual({
      ok: true,
    });
  return m;
}

/** The value a formula gives, typed in a free cell of a model. */
function evaluate(m: CellsModel, formula: string, at = { row: 100, col: 10 }): unknown {
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at, cells: [[{ formula }]] });
  const v = m.value('s1', at.row, at.col);
  return isCellError(v) ? v.error : v;
}

const formulaAt = (m: CellsModel, row: number, col: number) => m.content('s1', row, col)?.formula;

describe('the evaluator', () => {
  it('computes operators with precedence and coercions', () => {
    const m = model([]);
    const cases: [string, unknown][] = [
      ['1+2*3', 7],
      ['(1+2)*3', 9],
      ['-2^2', 4],
      ['2^3^2', 64],
      ['10/4', 2.5],
      ['5%', 0.05],
      ['"a"&"b"&1', 'ab1'],
      ['1=1', true],
      ['"A"="a"', true],
      ['1<"a"', true],
      ['"a"<TRUE', true],
      ['1/0', '#DIV/0!'],
      ['"x"+1', '#VALUE!'],
      ['"3"+1', 4],
      ['TRUE+1', 2],
      ['0^0', '#NUM!'],
      ['#N/A+1', '#N/A'],
      ['NOPE(1)', '#NAME?'],
      ['some_name', '#NAME?'],
    ];
    for (const [f, want] of cases) expect([f, evaluate(m, f)]).toEqual([f, want]);
  });

  it('reads references, ranges, whole columns, other sheets and array constants', () => {
    const m = model([
      [1, 10, 'a'],
      [2, 20, null],
      [3, 30, true],
    ]);
    m.dispatch({ type: 'ADD_SHEET', name: 'Other' });
    const other = m.sheets.find((s) => s.name === 'Other')!.id;
    m.dispatch({ type: 'SET_CELLS', sheet: other, at: { row: 0, col: 0 }, cells: [[42]] });
    expect(evaluate(m, 'A1+B2')).toBe(21);
    expect(evaluate(m, 'C2')).toBe(0); // an empty cell shows 0
    expect(evaluate(m, 'SUM(A1:B3)')).toBe(66);
    expect(evaluate(m, 'SUM(A:A)')).toBe(6);
    expect(evaluate(m, 'SUM(1:1)')).toBe(11);
    expect(evaluate(m, 'SUM(A1:A3,B1,5)')).toBe(21);
    expect(evaluate(m, 'SUM((A1,B3))')).toBe(31);
    expect(evaluate(m, 'SUM(A1:B3 B2:C3)')).toBe(50);
    expect(evaluate(m, 'SUM(A1:A2 C1:C2)')).toBe('#NULL!');
    expect(evaluate(m, 'SUM(A1:INDEX_NOT_A_REF)')).toBe('#NAME?');
    expect(evaluate(m, 'Other!A1*2')).toBe(84);
    expect(evaluate(m, "'Other'!A1")).toBe(42);
    expect(evaluate(m, 'Nowhere!A1')).toBe('#REF!');
    expect(evaluate(m, 'SUM({1,2;3,4})')).toBe(10);
    expect(evaluate(m, 'COUNT(A1:C3)')).toBe(3 + 3);
    expect(evaluate(m, 'CONCAT(C1:C3)')).toBe('aTRUE');
    expect(evaluate(m, 'AVERAGE(A1:A3)')).toBe(2);
    expect(evaluate(m, 'MIN(A1:B3)')).toBe(1);
    expect(evaluate(m, 'MAX(A1:B3)')).toBe(30);
    expect(evaluate(m, 'ROUND(2.675,2)')).toBe(2.68);
  });

  it('intersects a range with the formula row or column where one value is expected', () => {
    const m = model([[1], [2], [3]]);
    expect(evaluate(m, 'A1:A3*10', { row: 1, col: 4 })).toBe(20);
    expect(evaluate(m, 'A1:A3*10', { row: 7, col: 4 })).toBe('#VALUE!');
  });

  it('evaluates lazily: IF computes only the branch taken, IFERROR catches', () => {
    const m = model([[0]]);
    expect(evaluate(m, 'IF(A1=0,"zero",1/A1)')).toBe('zero');
    expect(evaluate(m, 'IF(A1,1)')).toBe(false);
    expect(evaluate(m, 'IFERROR(1/A1,"none")')).toBe('none');
    expect(evaluate(m, 'IFERROR(1/0)')).toBe('#VALUE!'); // too few arguments
    expect(evaluate(m, 'SUM(1/0,1)')).toBe('#DIV/0!');
  });

  it('recalculates after a change, and undo brings the old value back', () => {
    const m = model([[1, { formula: 'A1*2' }]]);
    expect(m.value('s1', 0, 1)).toBe(2);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[5]] });
    expect(m.value('s1', 0, 1)).toBe(10);
    m.undo();
    expect(m.value('s1', 0, 1)).toBe(2);
  });

  it('turns cycles into #CYCLE!, and a formula that does not parse into #NAME?', () => {
    const m = model([
      [{ formula: 'B1+1' }, { formula: 'A1+1' }, { formula: 'C1' }, { formula: '1+' }],
    ]);
    expect(m.value('s1', 0, 0)).toMatchObject({ error: '#CYCLE!' });
    expect(m.value('s1', 0, 1)).toMatchObject({ error: '#CYCLE!' });
    expect(m.value('s1', 0, 2)).toMatchObject({ error: '#CYCLE!' });
    expect(m.value('s1', 0, 3)).toMatchObject({ error: '#NAME?' });
  });

  it('reads the far end of a 100,000-deep chain without overflowing the stack', () => {
    const m = model([[1]]);
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [[{ formula: 'A1+1' }]],
    });
    m.dispatch({ type: 'FILL', sheet: 's1', source: z(1, 0), target: z(1, 0, 99_999, 0) });
    expect(m.value('s1', 99_999, 0)).toBe(100_000);
    // A cycle longer than the stack is still a cycle.
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [[{ formula: 'A100000' }]],
    });
    expect(m.value('s1', 99_999, 0)).toMatchObject({ error: '#CYCLE!' });
  });
});

describe('the shape cache', () => {
  it('gives formulas filled down one shape, their literals as constants', () => {
    const a = shapeOf(parseFormula('A1*2+$B$1+"x"').ast, { row: 0, col: 2 });
    const b = shapeOf(parseFormula('A9*7+$B$1+"y"').ast, { row: 8, col: 2 });
    expect(a.key).toBe(b.key);
    expect(a.constants).toEqual([2, 'x']);
    expect(b.constants).toEqual([7, 'y']);
  });

  it('compiles fewer than 50 shapes for a 100,000-formula fill', () => {
    const m = model([]);
    m.loadColumns('s1', { row: 0, col: 0 }, [Array.from({ length: 100_000 }, (_, i) => i)]);
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 1 },
      cells: [[{ formula: 'A1*2+$A$1' }, { formula: 'IF(A1>5,B1,0)' }, { formula: 'SUM(A1:B2)' }]],
    });
    m.dispatch({ type: 'FILL', sheet: 's1', source: z(0, 1, 0, 3), target: z(0, 1, 99_999, 3) });
    let total = 0;
    for (let r = 0; r < 100_000; r += 1) total += m.value('s1', r, 1) as number;
    expect(total).toBe(99_999 * 100_000);
    expect(m.value('s1', 99_999, 2)).toBe(199_998);
    expect(m.value('s1', 999, 3)).toBe(999 + 1000 + 1998 + 2000);
    const { engine } = m.stats();
    expect(engine.shapes).toBeLessThan(50);
    expect(engine.compiles).toBe(engine.shapes);
  });

  it('compiles again when a plugin contributing a function is switched off', () => {
    const Twice = definePlugin({
      name: '@acme/twice',
      contributes: [
        contribution(CellsFunctions, {
          name: 'TWICE',
          args: [{ name: 'x', type: 'scalar' }],
          returns: 'number',
          category: 'math',
          compute: ([x]) => (x as number) * 2,
          description: 'Twice a number.',
          examples: ['=TWICE(2) → 4'],
        }),
      ],
    });
    const m = model([[{ formula: 'TWICE(21)' }]], { plugins: [Twice] });
    expect(m.value('s1', 0, 0)).toBe(42);
    const origins: string[] = [];
    m.subscribe((tx) => origins.push(tx.origin));
    m.reactor.disable('@acme/twice');
    expect(m.value('s1', 0, 0)).toMatchObject({ error: '#NAME?' });
    m.reactor.enable('@acme/twice');
    expect(m.value('s1', 0, 0)).toBe(42);
    expect(origins).toEqual(['plugins', 'plugins']);
  });
});

describe('relative references follow copies', () => {
  it('translates only the relative part, and refuses moves off the sheet with #REF!', () => {
    expect(translateFormula('A1+$B$1+B$2+$C3', 2, 1)).toBe('B3+$B$1+C$2+$C5');
    expect(translateFormula('SUM(A1:A3)', 1, 0)).toBe('SUM(A2:A4)');
    expect(translateFormula('A1+1', -1, 0)).toBe('#REF!+1');
    expect(translateFormula('SUM(A:A)', 0, 1)).toBe('SUM(B:B)');
    // Transposed: the cell above becomes the cell to the left; anchors stay.
    expect(transposeFormula('A1+$B$1+A$1', { row: 1, col: 0 }, { row: 0, col: 1 })).toBe(
      'A1+$B$1+B$1',
    );
  });

  it('pasting =A1+$B$1 moves A1 and keeps $B$1; a cut keeps both', () => {
    const m = model([[1, 100, { formula: 'A1+$B$1' }], [2]]);
    const slice = m.copy(z(0, 2));
    m.paste(slice, { row: 1, col: 2 });
    expect(formulaAt(m, 1, 2)).toBe('A2+$B$1');
    expect(m.value('s1', 1, 2)).toBe(102);
    m.paste(slice, { row: 1, col: 3 });
    expect(formulaAt(m, 1, 3)).toBe('B2+$B$1');
    const cut = m.copy(z(0, 2), { cut: true });
    m.paste(cut, { row: 5, col: 5 });
    expect(formulaAt(m, 5, 5)).toBe('A1+$B$1');
    // A paste of values pastes what the formula showed.
    m.paste(m.copy(z(1, 2)), { row: 7, col: 0 }, { special: 'values' });
    expect(m.content('s1', 7, 0)).toMatchObject({ value: 102 });
    expect(formulaAt(m, 7, 0)).toBeUndefined();
  });

  it('filling =A1+$B$1 down and right moves A1 and keeps $B$1', () => {
    const m = model([[1, 100, { formula: 'A1+$B$1' }], [2], [3]]);
    m.dispatch({ type: 'FILL', sheet: 's1', source: z(0, 2), target: z(0, 2, 2, 2) });
    expect([formulaAt(m, 1, 2), formulaAt(m, 2, 2)]).toEqual(['A2+$B$1', 'A3+$B$1']);
    expect(m.value('s1', 2, 2)).toBe(103);
    m.dispatch({ type: 'FILL', sheet: 's1', source: z(0, 2), target: z(0, 2, 0, 3) });
    expect(formulaAt(m, 0, 3)).toBe('B1+$B$1');
  });

  it('sorting rows keeps each formula on its own row, sorting by what formulas show', () => {
    const m = model([
      [3, { formula: 'A1*10' }],
      [1, { formula: 'A2*10' }],
      [2, { formula: 'A3*10' }],
    ]);
    m.dispatch({ type: 'SORT', sheet: 's1', zone: z(0, 0, 2, 1), keys: [{ col: 1 }] });
    expect([0, 1, 2].map((r) => m.value('s1', r, 0))).toEqual([1, 2, 3]);
    expect([0, 1, 2].map((r) => formulaAt(m, r, 1))).toEqual(['A1*10', 'A2*10', 'A3*10']);
    expect([0, 1, 2].map((r) => m.value('s1', r, 1))).toEqual([10, 20, 30]);
  });
});

describe('the dependency graph', () => {
  /** A plugin function counting its calls, to see what recalculates. */
  function counted() {
    const calls = { n: 0 };
    const Count = definePlugin({
      name: '@acme/count',
      contributes: [
        contribution(CellsFunctions, {
          name: 'COUNTED',
          args: [{ name: 'x', type: 'scalar' }],
          returns: 'any',
          category: 'other',
          compute: ([x]) => {
            calls.n += 1;
            return x as number;
          },
          description: 'Its argument, counting calls.',
          examples: ['=COUNTED(1) → 1'],
        }),
        contribution(CellsFunctions, {
          name: 'TICK',
          args: [],
          returns: 'number',
          category: 'other',
          volatile: true,
          compute: () => {
            calls.n += 1;
            return calls.n;
          },
          description: 'A volatile counter.',
          examples: ['=TICK()'],
        }),
      ],
    });
    return { calls, Count };
  }

  it('recalculates what depends on a change, and only that', () => {
    const { calls, Count } = counted();
    const m = model(
      [
        [1, { formula: 'COUNTED(A1)*2' }],
        [2, { formula: 'COUNTED(A2)*2' }],
        [3, { formula: 'COUNTED(B1+B2)' }],
      ],
      { plugins: [Count] },
    );
    expect([m.value('s1', 0, 1), m.value('s1', 1, 1), m.value('s1', 2, 1)]).toEqual([2, 4, 6]);
    expect(calls.n).toBe(3);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 0 }, cells: [[5]] });
    expect([m.value('s1', 0, 1), m.value('s1', 1, 1), m.value('s1', 2, 1)]).toEqual([2, 10, 12]);
    expect(calls.n).toBe(5); // B2 and B3, not B1
  });

  it('follows ranges, whole columns and other sheets through the R-tree', () => {
    const m = model([[1, { formula: 'SUM(A:A)' }, { formula: 'SUM(A1:A3)' }], [2], [3]]);
    m.dispatch({ type: 'ADD_SHEET', name: 'Other' });
    const other = m.sheets.find((s) => s.name === 'Other')!.id;
    m.dispatch({
      type: 'SET_CELLS',
      sheet: other,
      at: { row: 0, col: 0 },
      cells: [[{ formula: 'Sheet1!B1*10' }]],
    });
    expect([m.value('s1', 0, 1), m.value('s1', 0, 2), m.value(other, 0, 0)]).toEqual([6, 6, 60]);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 999, col: 0 }, cells: [[100]] });
    expect([m.value('s1', 0, 1), m.value('s1', 0, 2), m.value(other, 0, 0)]).toEqual([
      106, 6, 1060,
    ]);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 0 }, cells: [[null]] });
    expect([m.value('s1', 0, 1), m.value('s1', 0, 2)]).toEqual([103, 3]);
  });

  it('recalculates volatile functions on every change', () => {
    const { Count } = counted();
    const m = model([[{ formula: 'TICK()' }, { formula: 'A1*10' }]], { plugins: [Count] });
    const first = m.value('s1', 0, 1) as number;
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 5, col: 5 }, cells: [[1]] });
    expect(m.value('s1', 0, 1)).toBe(first + 10);
  });

  it('a rewritten formula reads its new precedents and leaves its old ones', () => {
    const m = model([[1, 2, { formula: 'A1' }]]);
    expect(m.value('s1', 0, 2)).toBe(1);
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 2 },
      cells: [[{ formula: 'B1' }]],
    });
    expect(m.value('s1', 0, 2)).toBe(2);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 1 }, cells: [[7]] });
    expect(m.value('s1', 0, 2)).toBe(7);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[9]] });
    expect(m.value('s1', 0, 2)).toBe(7);
  });

  it('finishes the recalculation in the background, in slices', async () => {
    const m = model([[1]]);
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 1, col: 0 },
      cells: [[{ formula: 'A1+1' }]],
    });
    m.dispatch({ type: 'FILL', sheet: 's1', source: z(1, 0), target: z(1, 0, 49_999, 0) });
    expect(m.value('s1', 49_999, 0)).toBe(50_000);
    const idle = () =>
      expect.poll(() => m.stats().engine.calculating, { timeout: 10_000, interval: 5 }).toBe(false);
    await idle(); // the fill's own queue, already computed by the read
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[2]] });
    expect(m.stats().engine).toMatchObject({ calculating: true, pending: 49_999 });
    // A read meanwhile is never stale.
    expect(m.value('s1', 10, 0)).toBe(12);
    await idle();
    expect(m.stats().engine.pending).toBe(0);
    expect(m.stats().engine.lastSliceMs).toBeLessThan(50);
    expect(m.value('s1', 49_999, 0)).toBe(50_001);
  });

  it('starts over when rows move, the formulas following them', () => {
    const m = model([[1, { formula: 'A1*2' }]]);
    expect(m.value('s1', 0, 1)).toBe(2);
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 });
    expect(formulaAt(m, 1, 1)).toBe('A2*2');
    expect(m.value('s1', 1, 1)).toBe(2);
    expect(m.stats().engine.parsed).toBe(1);
  });
});

describe('formulas follow rows and columns', () => {
  function sheetWith() {
    const m = model([[1, { formula: 'A5+$A$5' }, { formula: 'SUM(A1:A9)' }], [2], [3], [4], [5]]);
    m.dispatch({ type: 'ADD_SHEET', name: 'Other' });
    const other = m.sheets.find((s) => s.name === 'Other')!.id;
    m.dispatch({
      type: 'SET_CELLS',
      sheet: other,
      at: { row: 0, col: 0 },
      cells: [[{ formula: 'Sheet1!A5*10' }, { formula: 'A5' }]],
    });
    return { m, other };
  }

  it('inserting rows moves references below them, anchored or not, on every sheet', () => {
    const { m, other } = sheetWith();
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 2, n: 2 });
    expect([formulaAt(m, 0, 1), formulaAt(m, 0, 2)]).toEqual(['A7+$A$7', 'SUM(A1:A11)']);
    expect(m.content(other, 0, 0)?.formula).toBe('Sheet1!A7*10');
    expect(m.content(other, 0, 1)?.formula).toBe('A5'); // its own sheet did not change
    expect([m.value('s1', 0, 1), m.value('s1', 0, 2), m.value(other, 0, 0)]).toEqual([10, 15, 50]);
    m.undo();
    expect([formulaAt(m, 0, 1), formulaAt(m, 0, 2)]).toEqual(['A5+$A$5', 'SUM(A1:A9)']);
    expect(m.content(other, 0, 0)?.formula).toBe('Sheet1!A5*10');
  });

  it('deleting rows turns references to them into #REF! and shrinks ranges', () => {
    const { m, other } = sheetWith();
    m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 3, n: 2 });
    expect([formulaAt(m, 0, 1), formulaAt(m, 0, 2)]).toEqual(['#REF!+#REF!', 'SUM(A1:A7)']);
    expect(m.value('s1', 0, 1)).toMatchObject({ error: '#REF!' });
    expect(m.value('s1', 0, 2)).toBe(6);
    expect(m.content(other, 0, 0)?.formula).toBe('#REF!*10');
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 9, col: 0 },
      cells: [[{ formula: 'SUM(A3:A4)' }]],
    });
    m.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 2, n: 2 });
    expect(formulaAt(m, 7, 0)).toBe('SUM(#REF!)');
  });

  it('moving rows carries references with them', () => {
    const { m } = sheetWith();
    // Row 5 (index 4) moves to the top.
    m.dispatch({ type: 'MOVE_AXIS', sheet: 's1', axis: 'rows', at: 4, n: 1, to: 0 });
    expect(formulaAt(m, 1, 1)).toBe('A1+$A$1');
    expect(m.value('s1', 1, 1)).toBe(10);
  });

  it('inserting columns moves column references; whole columns too', () => {
    const m = model([[1, 2, { formula: 'SUM(A:B)+B1' }]]);
    m.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'cols', at: 1, n: 1 });
    expect(formulaAt(m, 0, 3)).toBe('SUM(A:C)+C1');
    expect(m.value('s1', 0, 3)).toBe(5);
  });
});

describe('custom and asynchronous functions', () => {
  function slow() {
    const resolvers: ((v: number) => void)[] = [];
    const Slow = definePlugin({
      name: '@acme/slow',
      contributes: [
        contribution(CellsFunctions, {
          name: 'SLOW',
          args: [{ name: 'x', type: 'scalar' }],
          returns: 'number',
          category: 'other',
          async: true,
          compute: ([x]) =>
            new Promise<number>((resolve) => resolvers.push(() => resolve((x as number) * 10))),
          description: 'Ten times a number, later.',
          examples: ['=SLOW(2) → 20'],
        }),
      ],
    });
    return { Slow, resolvers };
  }

  it('is #BUSY! while it runs, then resolves into its cell and its dependents recalculate', async () => {
    const { Slow, resolvers } = slow();
    const m = model([[2, { formula: 'SLOW(A1)' }, { formula: 'B1+1' }]], { plugins: [Slow] });
    const origins: string[] = [];
    m.subscribe((tx) => origins.push(tx.origin));
    expect(m.value('s1', 0, 1)).toMatchObject({ error: '#BUSY!' });
    expect(m.value('s1', 0, 2)).toMatchObject({ error: '#BUSY!' });
    expect(m.stats().engine.busy).toBe(1);
    await expect.poll(() => resolvers.length).toBe(1);
    resolvers[0](0);
    await expect.poll(() => m.value('s1', 0, 1)).toBe(20);
    expect(m.value('s1', 0, 2)).toBe(21);
    expect(origins).toEqual(['async']);
    expect(m.stats().engine.busy).toBe(0);
    // A new argument runs it again.
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[3]] });
    expect(m.value('s1', 0, 1)).toMatchObject({ error: '#BUSY!' });
    await expect.poll(() => resolvers.length).toBe(2);
    resolvers[1](0);
    await expect.poll(() => m.value('s1', 0, 2)).toBe(31);
  });

  it('a function contributed twice is refused, naming both plugins', () => {
    const twice = (name: string) =>
      definePlugin({
        name,
        contributes: [
          contribution(CellsFunctions, {
            name: 'TWIN',
            args: [],
            returns: 'number',
            category: 'other',
            compute: () => 1,
            description: 'One.',
            examples: ['=TWIN() → 1'],
          }),
        ],
      });
    expect(() => model([], { plugins: [twice('@acme/one'), twice('@acme/two')] })).toThrow(
      /'TWIN' is contributed twice.*@acme\/one.*@acme\/two/,
    );
  });

  it('a promise from a function not declared asynchronous is a bug, said as such', () => {
    const Sneaky = definePlugin({
      name: '@acme/sneaky',
      contributes: [
        contribution(CellsFunctions, {
          name: 'SNEAKY',
          args: [],
          returns: 'number',
          category: 'other',
          compute: () => Promise.resolve(1),
          description: 'A promise.',
          examples: ['=SNEAKY()'],
        }),
      ],
    });
    // Loaded, not typed: nothing is queued for the background, which would throw it again.
    const m = createCellsModel({
      plugins: [Sneaky],
      data: {
        version: 1,
        sheets: [
          { id: 's1', name: 'Sheet1', rows: { '0': { cells: { '0': { f: 'SNEAKY()' } } } } },
        ],
      },
    });
    expect(() => m.value('s1', 0, 0)).toThrow(/declare it with async: true/);
  });
});
