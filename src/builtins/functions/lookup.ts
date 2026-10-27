/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** @module builtins/functions/lookup */

import { type CellValue, isCellError } from '../../core/values.js';
import { parseFormula } from '../../formula/parser.js';
import { compare, fail, isReference, type Reference, type Value } from '../../formula/values.js';
import type { FormulaFunction, FunctionContext } from '../../points/index.js';
import { cellOf, fn, type Grid, grid, int, text, vector, wildcard } from './args.js';

/** Whether a cell holds what is looked for: same type, text in any case (with wildcards when asked). */
function same(wanted: CellValue, v: CellValue, wildcards: boolean): boolean {
  if (v === null || isCellError(v)) return false;
  if (typeof wanted === 'string' && typeof v === 'string')
    return wildcards ? wildcard(wanted).test(v) : wanted.toLowerCase() === v.toLowerCase();
  return typeof wanted === typeof v && compare(wanted, v) === 0;
}

/** Comparable as an approximate match does: same type only. */
const comparable = (a: CellValue, b: CellValue) =>
  b !== null && !isCellError(b) && typeof a === typeof b;

/**
 * The index of what is looked for in a list: exact (wildcards for text), or
 * approximate on an ascending list (the last value not above) or a descending
 * one (the last value not below).
 */
function find(
  wanted: CellValue,
  list: readonly CellValue[],
  mode: 'exact' | 'below' | 'above',
): number {
  if (mode === 'exact') return list.findIndex((v) => same(wanted, v, true));
  let found = -1;
  for (let i = 0; i < list.length; i += 1) {
    const v = list[i];
    if (!comparable(wanted, v)) continue;
    const d = compare(v, wanted);
    if (mode === 'below') {
      if (d > 0) break;
      found = i;
    } else {
      if (d < 0) break;
      found = i;
    }
  }
  return found;
}

function column(g: Grid, c: number): CellValue[] {
  const out: CellValue[] = [];
  for (let r = 0; r < g.rows; r += 1) out.push(g.get(r, c));
  return out;
}

function row(g: Grid, r: number): CellValue[] {
  const out: CellValue[] = [];
  for (let c = 0; c < g.cols; c += 1) out.push(g.get(r, c));
  return out;
}

const approximate = (v: unknown) => v === undefined || (v !== false && v !== 0 && v !== null);

/** A sub-range of a grid's reference, or a value when the grid is no reference. */
function slice(g: Grid, top: number, left: number, rows: number, cols: number): Value {
  if (g.ref === undefined) {
    if (rows === 1 && cols === 1) return g.get(top, left);
    return fail('#VALUE!', 'A part of an array where a reference is expected.');
  }
  const z = g.ref.zone;
  return {
    kind: 'ref',
    sheet: g.ref.sheet,
    zone: {
      top: z.top + top,
      left: z.left + left,
      bottom: z.top + top + rows - 1,
      right: z.left + left + cols - 1,
    },
  };
}

function resolve(c: FunctionContext, name: string | undefined): string {
  if (name === undefined) return c.sheet;
  return c.sheetByName(name) ?? fail('#REF!', `No sheet named '${name}'.`);
}

export const LOOKUP: readonly FormulaFunction[] = [
  fn(
    'VLOOKUP',
    'lookup',
    'value:n table:r column:n approximate:n?',
    'any',
    'Looks a value up in a table’s first column and gives the cell of another column on its row.',
    ['=VLOOKUP(3, A1:C10, 2, FALSE)'],
    ([v, table, col, approx], c) => {
      const g = grid(table, c);
      const k = int(col);
      if (k < 1) fail('#VALUE!', 'The column starts at 1.');
      if (k > g.cols) fail('#REF!', 'The column is past the table.');
      const i = find(v as CellValue, column(g, 0), approximate(approx) ? 'below' : 'exact');
      return i < 0 ? fail('#N/A', 'Not found.') : g.get(i, k - 1);
    },
  ),
  fn(
    'HLOOKUP',
    'lookup',
    'value:n table:r row:n approximate:n?',
    'any',
    'Looks a value up in a table’s first row and gives the cell of another row in its column.',
    ['=HLOOKUP(2, A1:F3, 3, FALSE)'],
    ([v, table, r, approx], c) => {
      const g = grid(table, c, true);
      const k = int(r);
      if (k < 1) fail('#VALUE!', 'The row starts at 1.');
      if (k > g.rows) fail('#REF!', 'The row is past the table.');
      const i = find(v as CellValue, row(g, 0), approximate(approx) ? 'below' : 'exact');
      return i < 0 ? fail('#N/A', 'Not found.') : g.get(k - 1, i);
    },
  ),
  fn(
    'XLOOKUP',
    'lookup',
    'value:n lookup:r result:r if_not_found:a? match_mode:n? search_mode:n?',
    'any',
    'Looks a value up in a row or column and gives what is at the same place in another.',
    ['=XLOOKUP("fig", C1:C10, F1:F10)'],
    ([v, lookup, result, missing, matchMode, searchMode], c) => {
      const look = grid(lookup, c);
      const list = vector(look);
      const res = grid(result, c, true);
      const m = int(matchMode, 0);
      const s = int(searchMode, 1);
      const order = s === -1 || s === -2 ? [...list.keys()].reverse() : [...list.keys()];
      const wanted = v as CellValue;
      let found = -1;
      if (m === 0 || m === 2) {
        found = order.find((i) => same(wanted, list[i], m === 2)) ?? -1;
      } else if (m === -1 || m === 1) {
        let best = -1;
        for (const i of order) {
          const x = list[i];
          if (!comparable(wanted, x)) continue;
          const d = compare(x, wanted);
          if (d === 0) {
            best = i;
            break;
          }
          if (
            (m === -1 && d < 0 && (best < 0 || compare(x, list[best]) > 0)) ||
            (m === 1 && d > 0 && (best < 0 || compare(x, list[best]) < 0))
          )
            best = i;
        }
        found = best;
      } else fail('#VALUE!', 'The match mode is 0, -1, 1 or 2.');
      if (found < 0) {
        if (missing !== undefined) return missing as CellValue;
        return fail('#N/A', 'Not found.');
      }
      return look.cols === 1
        ? slice(res, found, 0, 1, res.cols)
        : slice(res, 0, found, res.rows, 1);
    },
  ),
  fn(
    'INDEX',
    'lookup',
    'range:r row:n column:n?',
    'any',
    'The cell at a row and column of a range; row 0 is a whole column, column 0 a whole row.',
    ['=INDEX(A1:C3, 2, 3)'],
    ([range, r, col], c) => {
      const g = grid(range, c, true);
      let i = int(r, 0);
      let k = int(col, 0);
      if (col === undefined && g.rows === 1 && g.cols > 1) {
        k = i;
        i = 0;
      } else if (col === undefined && g.cols === 1) k = 1;
      if (i < 0 || k < 0) fail('#VALUE!', 'A negative row or column.');
      if (i > g.rows || k > g.cols) fail('#REF!', 'Past the range.');
      if (i === 0 && k === 0) return slice(g, 0, 0, g.rows, g.cols);
      if (i === 0) return slice(g, 0, k - 1, g.rows, 1);
      if (k === 0) return slice(g, i - 1, 0, 1, g.cols);
      return cellOf(g, i - 1, k - 1);
    },
  ),
  fn(
    'MATCH',
    'lookup',
    'value:n range:r type:n?',
    'number',
    'Where a value is in a row or column: exactly (0), the last not above it (1, ascending), the last not below it (-1, descending).',
    ['=MATCH("cherry", C1:C10, 0) → 3'],
    ([v, range, type], c) => {
      const t = int(type, 1);
      const i = find(
        v as CellValue,
        vector(grid(range, c)),
        t === 0 ? 'exact' : t > 0 ? 'below' : 'above',
      );
      return i < 0 ? fail('#N/A', 'Not found.') : i + 1;
    },
  ),
  fn(
    'XMATCH',
    'lookup',
    'value:n range:r match_mode:n? search_mode:n?',
    'number',
    'Where a value is in a row or column, exactly by default.',
    ['=XMATCH(70, F1:F10) → 7'],
    ([v, range, matchMode, searchMode], c) => {
      const list = vector(grid(range, c));
      const m = int(matchMode, 0);
      const reverse = int(searchMode, 1) < 0;
      const order = reverse ? [...list.keys()].reverse() : [...list.keys()];
      const wanted = v as CellValue;
      if (m === 0 || m === 2) {
        const i = order.find((k) => same(wanted, list[k], m === 2));
        return i === undefined ? fail('#N/A', 'Not found.') : i + 1;
      }
      let best = -1;
      for (const k of order) {
        const x = list[k];
        if (!comparable(wanted, x)) continue;
        const d = compare(x, wanted);
        if (d === 0) return k + 1;
        if (
          (m === -1 && d < 0 && (best < 0 || compare(x, list[best]) > 0)) ||
          (m === 1 && d > 0 && (best < 0 || compare(x, list[best]) < 0))
        )
          best = k;
      }
      return best < 0 ? fail('#N/A', 'Not found.') : best + 1;
    },
  ),
  fn(
    'CHOOSE',
    'lookup',
    'index:n value1:l more:l...',
    'any',
    'The value at an index in a list.',
    ['=CHOOSE(2, "x", "y", "z") → y'],
    ([i, ...values]) => {
      const k = int(i);
      if (k < 1 || k > values.length) fail('#VALUE!', 'The index is outside the list.');
      const v = (values[k - 1] as () => CellValue)();
      return v === null ? 0 : v;
    },
  ),
  fn(
    'OFFSET',
    'lookup',
    'reference:r rows:n columns:n height:n? width:n?',
    'any',
    'A reference moved by rows and columns, of a height and width.',
    ['=SUM(OFFSET(A1, 1, 0, 3, 1))'],
    ([ref, rows, cols, height, width], c) => {
      if (!isReference(ref as Value)) fail('#VALUE!', 'OFFSET moves a reference.');
      const r = ref as Reference;
      const z = r.zone;
      const h = int(height, z.bottom - z.top + 1);
      const w = int(width, z.right - z.left + 1);
      const top = z.top + int(rows);
      const left = z.left + int(cols);
      const limits = c.limits(r.sheet);
      if (h < 1 || w < 1 || top < 0 || left < 0 || top + h > limits.rows || left + w > limits.cols)
        fail('#REF!', 'The reference moves off the sheet.');
      return {
        kind: 'ref',
        sheet: r.sheet,
        zone: { top, left, bottom: top + h - 1, right: left + w - 1 },
      };
    },
    { volatile: true },
  ),
  fn(
    'INDIRECT',
    'lookup',
    'reference:n a1:n?',
    'any',
    'The reference a text names, such as "B3" or "Sheet2!A1:C4".',
    ['=INDIRECT("F" & 3)'],
    ([t, a1], c) => {
      if (a1 === false || a1 === 0) fail('#REF!', 'R1C1 references are not read yet.');
      let ast;
      try {
        ast = parseFormula(text(t)).ast;
      } catch {
        return fail('#REF!', `'${text(t)}' is not a reference.`);
      }
      const limits = (s: string) => c.limits(s);
      if (ast.type === 'cell' && ast.ref.row !== undefined && ast.ref.col !== undefined) {
        const sheet = resolve(c, ast.sheet);
        const { row: r, col } = ast.ref;
        return { kind: 'ref', sheet, zone: { top: r, left: col, bottom: r, right: col } };
      }
      if (ast.type === 'range') {
        const sheet = resolve(c, ast.sheet);
        const l = limits(sheet);
        const r0 = ast.from.row ?? 0;
        const r1 = ast.to.row ?? l.rows - 1;
        const c0 = ast.from.col ?? 0;
        const c1 = ast.to.col ?? l.cols - 1;
        return {
          kind: 'ref',
          sheet,
          zone: {
            top: Math.min(r0, r1),
            left: Math.min(c0, c1),
            bottom: Math.max(r0, r1),
            right: Math.max(c0, c1),
          },
        };
      }
      return fail('#REF!', `'${text(t)}' is not a reference.`);
    },
    { volatile: true },
  ),
  fn(
    'ROW',
    'lookup',
    'reference:r?',
    'number',
    'The row number of a reference, or of the formula’s cell.',
    ['=ROW(C7) → 7'],
    ([ref], c) =>
      ref === undefined
        ? c.row + 1
        : isReference(ref as Value)
          ? (ref as Reference).zone.top + 1
          : fail('#VALUE!', 'ROW reads a reference.'),
  ),
  fn(
    'COLUMN',
    'lookup',
    'reference:r?',
    'number',
    'The column number of a reference, or of the formula’s cell.',
    ['=COLUMN(C7) → 3'],
    ([ref], c) =>
      ref === undefined
        ? c.col + 1
        : isReference(ref as Value)
          ? (ref as Reference).zone.left + 1
          : fail('#VALUE!', 'COLUMN reads a reference.'),
  ),
  fn(
    'ROWS',
    'lookup',
    'range:r',
    'number',
    'How many rows a range has.',
    ['=ROWS(A1:F10) → 10'],
    ([range], c) => grid(range, c, true).rows,
  ),
  fn(
    'COLUMNS',
    'lookup',
    'range:r',
    'number',
    'How many columns a range has.',
    ['=COLUMNS(A1:F10) → 6'],
    ([range], c) => grid(range, c, true).cols,
  ),
];
