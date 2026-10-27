/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What the built-in functions share: reading arguments (numbers of ranges,
 * a range as a grid, a reference's cells by position), Excel's criteria
 * (`">5"`, `"a*"`, `"<>"`), wildcards, and the 1900 date system.
 *
 * @module builtins/functions/args
 */

import { type CellValue, isCellError } from '../../core/values.js';
import type { FunctionArgument, FunctionContext, FormulaFunction } from '../../points/index.js';
import {
  compare,
  fail,
  isError,
  isMatrix,
  isReference,
  isUnion,
  type Reference,
  toNumber,
  toText,
  type Value,
} from '../../formula/values.js';

/** A function, its arguments written short: `n` scalar, `r` range, `a` any, `l` lazy; `?` optional, `...` repeating. */
export function fn(
  name: string,
  category: FormulaFunction['category'],
  args: string,
  returns: FormulaFunction['returns'],
  description: string,
  examples: readonly string[],
  compute: FormulaFunction['compute'],
  extra: { volatile?: boolean } = {},
): FormulaFunction {
  const kinds = { n: 'scalar', r: 'range', a: 'any', l: 'lazy' } as const;
  const parsed: FunctionArgument[] = args
    .split(' ')
    .filter((x) => x !== '')
    .map((spec) => {
      const m = /^([a-z][a-z0-9_]*):([nral])(\?|\.\.\.)?$/.exec(spec);
      if (m === null) throw new Error(`${name}: '${spec}' is not an argument spec.`);
      return {
        name: m[1],
        type: kinds[m[2] as keyof typeof kinds],
        ...(m[3] === '?' ? { optional: true } : {}),
        ...(m[3] === '...' ? { optional: true, repeating: true } : {}),
      };
    });
  return { name, category, args: parsed, returns, description, examples, compute, ...extra };
}

export const isRange = (v: unknown): v is Value & object =>
  typeof v === 'object' && v !== null && 'kind' in v;

/** A scalar argument as a number; missing is `fallback`. */
export const num = (v: unknown, fallback?: number): number =>
  v === undefined || (v === null && fallback !== undefined)
    ? (fallback ?? fail('#VALUE!', 'A number is missing.'))
    : toNumber(v as CellValue);
export const text = (v: unknown): string => toText(v as CellValue);
export const int = (v: unknown, fallback?: number): number => Math.trunc(num(v, fallback));

/**
 * The numbers of the arguments, as aggregates read them: from references,
 * numbers only (text, booleans and empty cells skipped); typed scalars
 * coerced. An error anywhere is the result.
 */
export function numbers(args: readonly unknown[], context: FunctionContext): number[] {
  const out: number[] = [];
  for (const a of args) {
    if (isRange(a)) {
      for (const x of context.values(a)) {
        if (isError(x)) fail(x.error, x.message);
        if (typeof x === 'number') out.push(x);
      }
    } else if (isError(a)) {
      fail(a.error, a.message);
    } else if (a !== null && a !== undefined) {
      out.push(toNumber(a as CellValue));
    }
  }
  return out;
}

/** Every value of the arguments, references read (empty cells skipped), scalars as they are. */
export function allValues(args: readonly unknown[], context: FunctionContext): CellValue[] {
  const out: CellValue[] = [];
  for (const a of args) {
    if (isRange(a)) out.push(...context.values(a));
    else if (a !== undefined) out.push(a as CellValue);
  }
  return out;
}

/** A range argument as a grid: rows and columns, read cell by cell (empty cells are `null`). */
export interface Grid {
  readonly rows: number;
  readonly cols: number;
  get(r: number, c: number): CellValue;
  /** The reference the grid reads, when it reads one (a sub-range of it is a reference too). */
  readonly ref?: Reference;
}

/**
 * A range as a grid. `full` keeps the reference's whole size; otherwise its
 * rows and columns are clipped to what holds something, so `A:A` is as tall
 * as its data.
 */
export function grid(arg: unknown, context: FunctionContext, full = false): Grid {
  const v = (arg === undefined ? null : arg) as Value;
  if (isReference(v)) {
    const ref = full ? v : context.extent(v);
    const z = ref.zone;
    return {
      rows: z.bottom - z.top + 1,
      cols: z.right - z.left + 1,
      get: (r, c) => context.cell(ref.sheet, z.top + r, z.left + c),
      ref,
    };
  }
  if (isMatrix(v)) {
    return {
      rows: v.rows.length,
      cols: v.rows[0]?.length ?? 0,
      get: (r, c) => v.rows[r]?.[c] ?? null,
    };
  }
  if (isUnion(v)) return fail('#VALUE!', 'A union of ranges where one range is expected.');
  return { rows: 1, cols: 1, get: () => (v as CellValue) ?? null };
}

/** The values of a single row or column, in order (a grid of either shape). */
export function vector(g: Grid): CellValue[] {
  const out: CellValue[] = [];
  if (g.rows === 1) for (let c = 0; c < g.cols; c += 1) out.push(g.get(0, c));
  else if (g.cols === 1) for (let r = 0; r < g.rows; r += 1) out.push(g.get(r, 0));
  else fail('#N/A', 'A row or a column is expected.');
  return out;
}

/** A sub-range of a grid's reference: what INDEX, OFFSET and XLOOKUP return. */
export function cellOf(g: Grid, r: number, c: number): Value {
  if (g.ref !== undefined) {
    const top = g.ref.zone.top + r;
    const left = g.ref.zone.left + c;
    return { kind: 'ref', sheet: g.ref.sheet, zone: { top, left, bottom: top, right: left } };
  }
  return g.get(r, c);
}

// ------------------------------------------------------------------ criteria and wildcards

/** A wildcard pattern (`*`, `?`, `~` escapes) as a case-insensitive regular expression. */
export function wildcard(pattern: string, whole = true): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) {
      i += 1;
      out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') out += '[\\s\\S]*';
    else if (ch === '?') out += '[\\s\\S]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(whole ? `^${out}$` : out, 'i');
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Excel's criterion: a value to equal, or text with an operator and wildcards. */
export function criterion(c: CellValue): (v: CellValue) => boolean {
  if (isCellError(c)) return (v) => isCellError(v) && v.error === c.error;
  if (typeof c === 'number') return (v) => v === c;
  if (typeof c === 'boolean') return (v) => v === c;
  const s = c ?? '';
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(s)!;
  const op = m[1] ?? '=';
  const operand = m[2];
  const isNum = NUMERIC.test(operand.trim());
  const n = isNum ? Number(operand) : NaN;
  const upper = operand.toUpperCase();
  const bool = upper === 'TRUE' ? true : upper === 'FALSE' ? false : undefined;
  const equals = (v: CellValue): boolean => {
    if (operand === '') return v === null || v === '';
    if (isNum) return v === n;
    if (bool !== undefined) return v === bool;
    return typeof v === 'string' && wildcard(operand).test(v);
  };
  if (op === '=') return equals;
  if (op === '<>') return (v) => !equals(v);
  return (v) => {
    let d: number;
    if (isNum) {
      if (typeof v !== 'number') return false;
      d = v - n;
    } else {
      if (typeof v !== 'string') return false;
      d = compare(v, operand);
    }
    return op === '<' ? d < 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d >= 0;
  };
}

/**
 * The positions (row, column) of a grid matching criteria pairs, all grids
 * of the same size as the first.
 */
export function matching(
  pairs: readonly [range: unknown, criterion: unknown][],
  context: FunctionContext,
): [number, number][] {
  const first = grid(pairs[0][0], context);
  const tests = pairs.map(([range, c]) => {
    const g = grid(range, context, true);
    return { g, test: criterion(c as CellValue) };
  });
  for (const { g } of tests) {
    if (g.cols !== first.cols || (g.rows < first.rows && g.ref === undefined))
      fail('#VALUE!', 'The criteria ranges differ in size.');
  }
  const out: [number, number][] = [];
  for (let r = 0; r < first.rows; r += 1)
    for (let c = 0; c < first.cols; c += 1)
      if (tests.every(({ g, test }) => test(g.get(r, c)))) out.push([r, c]);
  return out;
}

// ------------------------------------------------------------------ dates (the 1900 system)

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

/** The serial of a date, Excel's way: 1 is 1900-01-01, and 60 the 29 February 1900 Excel keeps. */
export function serial(year: number, month: number, day: number): number {
  const y = year < 1900 ? year + 1900 : year;
  const days = Math.round((Date.UTC(y, month - 1, day) - EPOCH) / DAY_MS);
  return days < 61 ? days - 1 : days;
}

/** The year, month (1–12), day and weekday (0 Sunday) of a serial. */
export function ymd(n: number): { year: number; month: number; day: number; weekday: number } {
  const whole = Math.floor(n);
  if (whole < 0) fail('#NUM!', 'A date before 1900.');
  if (whole === 60) return { year: 1900, month: 2, day: 29, weekday: 3 };
  const d = new Date(EPOCH + (whole < 60 ? whole + 1 : whole) * DAY_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: whole < 60 ? (d.getUTCDay() + 6) % 7 : d.getUTCDay(),
  };
}

/** A date argument: a serial, or text that reads as a date. */
export function dateArg(v: unknown): number {
  if (typeof v === 'string') {
    const parsed = parseDate(v);
    if (parsed !== undefined) return parsed;
  }
  const n = num(v);
  if (n < 0) fail('#NUM!', 'A date before 1900.');
  return n;
}

/** `2023-03-15`, `3/15/2023` and `15 March 2023` as serials; `undefined` for other text. */
export function parseDate(s: string): number | undefined {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return serial(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    const y = Number(m[3]);
    return serial(y < 100 ? (y < 30 ? 2000 + y : 1900 + y) : y, Number(m[1]), Number(m[2]));
  }
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{4})$/.exec(t);
  if (m) {
    const month = MONTHS.findIndex((x) => m![2].toLowerCase().startsWith(x)) + 1;
    if (month > 0) return serial(Number(m[3]), month, Number(m[1]));
  }
  return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The last day of a month, 1–12. */
export const daysIn = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Today's serial, and now's, in local time. */
export function now(): number {
  const d = new Date();
  return (
    serial(d.getFullYear(), d.getMonth() + 1, d.getDate()) +
    (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000) /
      86_400
  );
}
