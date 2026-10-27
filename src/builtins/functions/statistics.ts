/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** @module builtins/functions/statistics */

import type { CellValue } from '../../core/values.js';
import { fail } from '../../formula/values.js';
import type { FormulaFunction, FunctionContext } from '../../points/index.js';
import { allValues, fn, grid, int, isRange, matching, num, numbers } from './args.js';
import { pairs } from './math.js';

const NUMBERS = 'number1:r number2:r...';

function mean(xs: readonly number[]): number {
  if (xs.length === 0) fail('#DIV/0!', 'No numbers.');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: readonly number[], sample: boolean): number {
  if (xs.length < (sample ? 2 : 1)) fail('#DIV/0!', 'Too few numbers.');
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - (sample ? 1 : 0));
}

/** The numbers of a range at the positions criteria select. */
function selected(
  values: unknown,
  criteria: [unknown, CellValue][],
  context: FunctionContext,
): number[] {
  const g = grid(values, context, true);
  const out: number[] = [];
  for (const [r, c] of matching(criteria, context)) {
    const v = g.get(r, c);
    if (typeof v === 'number') out.push(v);
  }
  return out;
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const smallest = (xs: readonly number[]) => xs.reduce((a, b) => (b < a ? b : a), Infinity);
const largest = (xs: readonly number[]) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

export const STATISTICS: readonly FormulaFunction[] = [
  fn(
    'AVERAGE',
    'statistics',
    NUMBERS,
    'number',
    'The arithmetic mean.',
    ['=AVERAGE(2, 4, 9) → 5'],
    (a, c) => mean(numbers(a, c)),
  ),
  fn(
    'AVERAGEIF',
    'statistics',
    'range:r criterion:n average_range:r?',
    'number',
    'The mean of the cells meeting a criterion.',
    ['=AVERAGEIF(A1:A3, ">1")'],
    ([range, crit, avg], c) => mean(selected(avg ?? range, [[range, crit as CellValue]], c)),
  ),
  fn(
    'AVERAGEIFS',
    'statistics',
    'average_range:r range1:r criterion1:a more:r...',
    'number',
    'The mean of the cells meeting every criterion.',
    ['=AVERAGEIFS(C1:C3, A1:A3, "a")'],
    ([avg, ...rest], c) => mean(selected(avg, pairs(rest, c), c)),
  ),
  fn(
    'COUNT',
    'statistics',
    'value1:r value2:r...',
    'number',
    'How many numbers there are.',
    ['=COUNT(1, "a", 3) → 2'],
    (a, c) => {
      let n = 0;
      for (const x of a) {
        if (isRange(x)) {
          for (const v of c.values(x)) if (typeof v === 'number') n += 1;
        } else if (typeof x === 'number' || typeof x === 'boolean') n += 1;
        else if (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) n += 1;
      }
      return n;
    },
  ),
  fn(
    'COUNTA',
    'statistics',
    'value1:r value2:r...',
    'number',
    'How many values there are (empty cells left out).',
    ['=COUNTA("a", 1) → 2'],
    (a, c) => allValues(a, c).filter((v) => v !== null).length,
  ),
  fn(
    'COUNTBLANK',
    'statistics',
    'range:r',
    'number',
    'How many cells are empty (or hold empty text).',
    ['=COUNTBLANK(A1:A3)'],
    ([range], c) => {
      const g = grid(range, c, true);
      let n = 0;
      for (let r = 0; r < g.rows; r += 1)
        for (let col = 0; col < g.cols; col += 1) {
          const v = g.get(r, col);
          if (v === null || v === '') n += 1;
        }
      return n;
    },
  ),
  fn(
    'COUNTIF',
    'statistics',
    'range:r criterion:n',
    'number',
    'How many cells meet a criterion.',
    ['=COUNTIF(A1:A3, ">=2")'],
    ([range, crit], c) => matching([[range, crit]], c).length,
  ),
  fn(
    'COUNTIFS',
    'statistics',
    'range1:r criterion1:a more:r...',
    'number',
    'How many cells meet every criterion.',
    ['=COUNTIFS(A1:A3, "a", B1:B3, ">0")'],
    (a, c) => matching(pairs(a, c), c).length,
  ),
  fn(
    'MIN',
    'statistics',
    NUMBERS,
    'number',
    'The smallest number; 0 when there is none.',
    ['=MIN(4, -1, 7) → -1'],
    (a, c) => {
      const xs = numbers(a, c);
      return xs.length === 0 ? 0 : smallest(xs);
    },
  ),
  fn(
    'MAX',
    'statistics',
    NUMBERS,
    'number',
    'The largest number; 0 when there is none.',
    ['=MAX(4, -1, 7) → 7'],
    (a, c) => {
      const xs = numbers(a, c);
      return xs.length === 0 ? 0 : largest(xs);
    },
  ),
  fn(
    'MEDIAN',
    'statistics',
    NUMBERS,
    'number',
    'The middle number.',
    ['=MEDIAN(1, 3, 2, 4) → 2.5'],
    (a, c) => {
      const xs = sorted(numbers(a, c));
      if (xs.length === 0) fail('#NUM!', 'No numbers.');
      const m = xs.length >> 1;
      return xs.length % 2 === 1 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
    },
  ),
  fn(
    'STDEV',
    'statistics',
    NUMBERS,
    'number',
    'The standard deviation of a sample.',
    ['=STDEV(1, 2, 3, 4) → 1.290994449'],
    (a, c) => Math.sqrt(variance(numbers(a, c), true)),
  ),
  fn(
    'STDEVP',
    'statistics',
    NUMBERS,
    'number',
    'The standard deviation of a population.',
    ['=STDEVP(1, 2, 3, 4) → 1.118033989'],
    (a, c) => Math.sqrt(variance(numbers(a, c), false)),
  ),
  fn(
    'VAR',
    'statistics',
    NUMBERS,
    'number',
    'The variance of a sample.',
    ['=VAR(1, 2, 3, 4) → 1.666666667'],
    (a, c) => variance(numbers(a, c), true),
  ),
  fn(
    'VARP',
    'statistics',
    NUMBERS,
    'number',
    'The variance of a population.',
    ['=VARP(1, 2, 3, 4) → 1.25'],
    (a, c) => variance(numbers(a, c), false),
  ),
  fn(
    'LARGE',
    'statistics',
    'array:r k:n',
    'number',
    'The k-th largest number.',
    ['=LARGE({3,1,2}, 1) → 3'],
    ([arr, k], c) => {
      const xs = sorted(numbers([arr], c)).reverse();
      const i = Math.ceil(num(k)) - 1;
      return i < 0 || i >= xs.length ? fail('#NUM!', 'k is out of range.') : xs[i];
    },
  ),
  fn(
    'SMALL',
    'statistics',
    'array:r k:n',
    'number',
    'The k-th smallest number.',
    ['=SMALL({3,1,2}, 1) → 1'],
    ([arr, k], c) => {
      const xs = sorted(numbers([arr], c));
      const i = Math.ceil(num(k)) - 1;
      return i < 0 || i >= xs.length ? fail('#NUM!', 'k is out of range.') : xs[i];
    },
  ),
  fn(
    'RANK',
    'statistics',
    'number:n ref:r order:n?',
    'number',
    'A number’s rank in a list: 1 for the largest, or the smallest with order 1.',
    ['=RANK(3, {1,3,2}) → 1'],
    ([n, ref, order], c) => {
      const x = num(n);
      const xs = numbers([ref], c);
      if (!xs.includes(x)) fail('#N/A', 'The number is not in the list.');
      const ascending = int(order, 0) !== 0;
      return 1 + xs.filter((y) => (ascending ? y < x : y > x)).length;
    },
  ),
  fn(
    'MODE',
    'statistics',
    NUMBERS,
    'number',
    'The most frequent number (the first, on a tie).',
    ['=MODE(1, 2, 2, 3) → 2'],
    (a, c) => {
      const xs = numbers(a, c);
      const counts = new Map<number, number>();
      for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
      let best: number | undefined;
      let most = 1;
      for (const x of xs) {
        const n = counts.get(x)!;
        if (n > most) {
          most = n;
          best = x;
        }
      }
      return best === undefined ? fail('#N/A', 'No number repeats.') : best;
    },
  ),
  fn(
    'MAXIFS',
    'statistics',
    'max_range:r range1:r criterion1:a more:r...',
    'number',
    'The largest of the cells meeting every criterion; 0 when none does.',
    ['=MAXIFS(B1:B3, A1:A3, "a")'],
    ([values, ...rest], c) => {
      const xs = selected(values, pairs(rest, c), c);
      return xs.length === 0 ? 0 : largest(xs);
    },
  ),
  fn(
    'MINIFS',
    'statistics',
    'min_range:r range1:r criterion1:a more:r...',
    'number',
    'The smallest of the cells meeting every criterion; 0 when none does.',
    ['=MINIFS(B1:B3, A1:A3, "a")'],
    ([values, ...rest], c) => {
      const xs = selected(values, pairs(rest, c), c);
      return xs.length === 0 ? 0 : smallest(xs);
    },
  ),
];
