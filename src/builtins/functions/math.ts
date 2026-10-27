/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** @module builtins/functions/math */

import type { CellValue } from '../../core/values.js';
import { fail, numberToText } from '../../formula/values.js';
import type { FormulaFunction, FunctionContext } from '../../points/index.js';
import { fn, grid, int, isRange, matching, num, numbers } from './args.js';

/** Round half away from zero at `digits`, through 15 significant digits (2.675 rounds as it reads). */
function round(n: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const f = 10 ** digits;
  const scaled = Number(numberToText(Math.abs(n) * f));
  const r =
    mode === 'half' ? Math.round(scaled) : mode === 'up' ? Math.ceil(scaled) : Math.floor(scaled);
  return (Math.sign(n) * r) / f;
}

/** CEILING and FLOOR, Excel 2010's way: the quotient rounded up or down, times the step. */
function step(x: number, s: number, up: boolean): number {
  if (s === 0) return 0;
  if (x > 0 && s < 0) fail('#NUM!', 'A positive number with a negative step.');
  const q = Number(numberToText(x / s));
  return Number(numberToText((up ? Math.ceil(q) : Math.floor(q)) * s));
}

export const MATH: readonly FormulaFunction[] = [
  fn(
    'SUM',
    'math',
    'number1:r number2:r...',
    'number',
    'Adds numbers and the numbers of ranges.',
    ['=SUM(1, 2, 3) → 6'],
    (a, c) => numbers(a, c).reduce((x, y) => x + y, 0),
  ),
  fn(
    'SUMIF',
    'math',
    'range:r criterion:n sum_range:r?',
    'number',
    'Adds the cells of a range (or of a range beside it) that meet a criterion.',
    ['=SUMIF(A1:A3, ">1") with 1, 2, 3 → 5'],
    ([range, crit, sum], c) => {
      const values = grid(sum ?? range, c, true);
      let total = 0;
      for (const [r, col] of matching([[range, crit]], c)) {
        const v = values.get(r, col);
        if (typeof v === 'number') total += v;
      }
      return total;
    },
  ),
  fn(
    'SUMIFS',
    'math',
    'sum_range:r range1:r criterion1:a more:r...',
    'number',
    'Adds the cells meeting every criterion.',
    ['=SUMIFS(C1:C3, A1:A3, "a", B1:B3, ">0")'],
    ([sum, ...rest], c) => {
      const values = grid(sum, c, true);
      let total = 0;
      for (const [r, col] of matching(pairs(rest, c), c)) {
        const v = values.get(r, col);
        if (typeof v === 'number') total += v;
      }
      return total;
    },
  ),
  fn(
    'SUMPRODUCT',
    'math',
    'array1:r array2:r...',
    'number',
    'The sum of the products of matching cells; what is not a number counts as 0.',
    ['=SUMPRODUCT({1,2},{3,4}) → 11'],
    (a, c) => {
      const gs = a.map((x) => grid(x, c, true));
      if (gs.some((g) => g.rows !== gs[0].rows || g.cols !== gs[0].cols))
        fail('#VALUE!', 'The arrays differ in size.');
      let total = 0;
      for (let r = 0; r < gs[0].rows; r += 1)
        for (let col = 0; col < gs[0].cols; col += 1) {
          let p = 1;
          for (const g of gs) {
            const v = g.get(r, col);
            if (typeof v === 'object' && v !== null) fail(v.error, v.message);
            p *= typeof v === 'number' ? v : 0;
          }
          total += p;
        }
      return total;
    },
  ),
  fn(
    'PRODUCT',
    'math',
    'number1:r number2:r...',
    'number',
    'Multiplies numbers.',
    ['=PRODUCT(2, 3, 4) → 24'],
    (a, c) => numbers(a, c).reduce((x, y) => x * y, 1),
  ),
  fn(
    'ROUND',
    'math',
    'number:n digits:n',
    'number',
    'Rounds half away from zero.',
    ['=ROUND(2.567, 2) → 2.57'],
    ([n, d]) => round(num(n), int(d), 'half'),
  ),
  fn(
    'ROUNDUP',
    'math',
    'number:n digits:n',
    'number',
    'Rounds away from zero.',
    ['=ROUNDUP(2.121, 2) → 2.13'],
    ([n, d]) => round(num(n), int(d), 'up'),
  ),
  fn(
    'ROUNDDOWN',
    'math',
    'number:n digits:n',
    'number',
    'Rounds toward zero.',
    ['=ROUNDDOWN(-2.129, 2) → -2.12'],
    ([n, d]) => round(num(n), int(d), 'down'),
  ),
  fn('ABS', 'math', 'number:n', 'number', 'The absolute value.', ['=ABS(-3.5) → 3.5'], ([n]) =>
    Math.abs(num(n)),
  ),
  fn(
    'MOD',
    'math',
    'number:n divisor:n',
    'number',
    'The remainder, with the divisor’s sign.',
    ['=MOD(-10, 3) → 2'],
    ([n, d]) => {
      const x = num(n);
      const y = num(d);
      if (y === 0) fail('#DIV/0!', 'MOD by zero.');
      return Number(numberToText(x - y * Math.floor(x / y)));
    },
  ),
  fn(
    'POWER',
    'math',
    'number:n power:n',
    'number',
    'A number raised to a power.',
    ['=POWER(2, 10) → 1024'],
    ([n, p]) => {
      const x = num(n);
      const y = num(p);
      if (x === 0 && y <= 0) fail(y === 0 ? '#NUM!' : '#DIV/0!', '0 to that power.');
      return x ** y;
    },
  ),
  fn('SQRT', 'math', 'number:n', 'number', 'The square root.', ['=SQRT(16) → 4'], ([n]) => {
    const x = num(n);
    return x < 0 ? fail('#NUM!', 'The square root of a negative number.') : Math.sqrt(x);
  }),
  fn(
    'INT',
    'math',
    'number:n',
    'number',
    'Rounds down to an integer.',
    ['=INT(-2.5) → -3'],
    ([n]) => Math.floor(num(n)),
  ),
  fn(
    'TRUNC',
    'math',
    'number:n digits:n?',
    'number',
    'Cuts the digits after a point.',
    ['=TRUNC(-2.5) → -2'],
    ([n, d]) => round(num(n), int(d, 0), 'down'),
  ),
  fn(
    'CEILING',
    'math',
    'number:n step:n',
    'number',
    'Rounds up to a multiple of a step.',
    ['=CEILING(2.3, 1) → 3'],
    ([n, s]) => step(num(n), num(s), true),
  ),
  fn(
    'FLOOR',
    'math',
    'number:n step:n',
    'number',
    'Rounds down to a multiple of a step.',
    ['=FLOOR(2.7, 0.5) → 2.5'],
    ([n, s]) => step(num(n), num(s), false),
  ),
  fn('EXP', 'math', 'number:n', 'number', 'e to a power.', ['=EXP(1) → 2.718281828'], ([n]) =>
    Math.exp(num(n)),
  ),
  fn(
    'LN',
    'math',
    'number:n',
    'number',
    'The natural logarithm.',
    ['=LN(10) → 2.302585093'],
    ([n]) => {
      const x = num(n);
      return x <= 0 ? fail('#NUM!', 'The logarithm of a number not above 0.') : Math.log(x);
    },
  ),
  fn(
    'LOG',
    'math',
    'number:n base:n?',
    'number',
    'The logarithm in a base, 10 by default.',
    ['=LOG(8, 2) → 3'],
    ([n, b]) => {
      const x = num(n);
      const base = num(b, 10);
      if (x <= 0 || base <= 0) fail('#NUM!', 'The logarithm of a number not above 0.');
      if (base === 1) fail('#DIV/0!', 'A logarithm in base 1.');
      return Number(numberToText(Math.log(x) / Math.log(base)));
    },
  ),
  fn(
    'LOG10',
    'math',
    'number:n',
    'number',
    'The logarithm in base 10.',
    ['=LOG10(1000) → 3'],
    ([n]) => {
      const x = num(n);
      return x <= 0 ? fail('#NUM!', 'The logarithm of a number not above 0.') : Math.log10(x);
    },
  ),
  fn('PI', 'math', '', 'number', 'π.', ['=PI() → 3.141592654'], () => Math.PI),
  fn(
    'SIGN',
    'math',
    'number:n',
    'number',
    '1, 0 or -1, as the number’s sign.',
    ['=SIGN(-4) → -1'],
    ([n]) => Math.sign(num(n)),
  ),
  fn(
    'RAND',
    'math',
    '',
    'number',
    'A random number from 0 to 1.',
    ['=RAND()'],
    () => Math.random(),
    { volatile: true },
  ),
  fn(
    'RANDBETWEEN',
    'math',
    'low:n high:n',
    'number',
    'A random integer between two, both included.',
    ['=RANDBETWEEN(1, 6)'],
    ([lo, hi]) => {
      const a = Math.ceil(num(lo));
      const b = Math.floor(num(hi));
      if (a > b) fail('#NUM!', 'The low bound is above the high one.');
      return a + Math.floor(Math.random() * (b - a + 1));
    },
    { volatile: true },
  ),
];

/** `range, criterion` pairs of the …IFS functions; a criterion given as a cell is that cell's value. */
export function pairs(rest: readonly unknown[], context: FunctionContext): [unknown, CellValue][] {
  if (rest.length === 0 || rest.length % 2 !== 0)
    fail('#VALUE!', 'Ranges and criteria come in pairs.');
  const out: [unknown, CellValue][] = [];
  for (let i = 0; i < rest.length; i += 2) out.push([rest[i], scalarOf(rest[i + 1], context)]);
  return out;
}

/** A value given where one value is expected: a range by its first cell. */
export function scalarOf(v: unknown, context: FunctionContext): CellValue {
  return isRange(v) ? grid(v, context, true).get(0, 0) : ((v as CellValue) ?? null);
}
