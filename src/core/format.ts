/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The native file format, `CellsWorkbook`: sparse, readable JSON. Loading
 * validates the whole shape before it touches a model, and refuses a file
 * that does not match with a sentence naming the path of the first bad
 * field. A different `version` is refused; there are no migrations before 1.0.
 *
 * @module core/format
 */

import type { CellContent } from './cells.js';
import { type ChartSpec, checkChart } from './charts.js';
import { type CodeCell, codeKey, codePosition, codeProblem, codeRef } from './code.js';
import { checkStyle, type Style } from './styles.js';
import { type CellValue, cellError, isCellError, isErrorCode } from './values.js';
import { DEFAULT_LIMITS, type Limits, type Workbook } from './workbook.js';
import { type Zone, zoneContains } from './zone.js';
import { boundZone } from './dataSources.js';

/** The version of the `CellsWorkbook` format: a file of another version is refused, with no migration before 1.0. */
export const FORMAT_VERSION = 1;

/** A value as JSON carries it: errors as `{ error }`. */
export type JsonValue = number | string | boolean | null | { readonly error: string };

/** A cell in the file: its value `v`, its formula `f` (without the `=`), its style index `s`. */
export interface CellsCell {
  /** The value, or a formula's cached value. */
  readonly v?: JsonValue;
  /** The formula in A1 notation, without the `=`. */
  readonly f?: string;
  /** An index into `styles`. */
  readonly s?: number;
}

/** A sheet in the file: its id, name, rows of cells, sizes, hidden indexes, merges, frozen panes, charts and data source. */
export interface CellsSheet {
  readonly id: string;
  readonly name: string;
  readonly rows: Readonly<Record<string, { readonly cells: Readonly<Record<string, CellsCell>> }>>;
  readonly sizes?: {
    readonly rows?: Readonly<Record<string, number>>;
    readonly cols?: Readonly<Record<string, number>>;
  };
  readonly hidden?: { readonly rows?: readonly number[]; readonly cols?: readonly number[] };
  readonly merges?: readonly Zone[];
  readonly frozen?: { readonly rows: number; readonly cols: number };
  /** Charts by id (§3.12). */
  readonly charts?: Readonly<Record<string, ChartSpec>>;
  /** Code cells by their cell, `B4` (§3.13); the cell itself holds the result as its value. */
  readonly code?: Readonly<Record<string, CodeCell>>;
  /** The data source bound to the sheet (C7-03): which, where its first cell lands, and its shape; its rows are not in the file. */
  readonly dataSource?: {
    readonly id: string;
    readonly row: number;
    readonly col: number;
    readonly rows: number;
    readonly cols: number;
  };
}

/** The file format (§3.1): versioned JSON of sheets and a style table, validated whole before it is loaded. */
export interface CellsWorkbook {
  readonly version: 1;
  readonly sheets: readonly CellsSheet[];
  /** Index 0 is the default style and may be omitted (`[]`). */
  readonly styles?: readonly Style[];
}

class FormatError extends Error {}

function fail(path: string, message: string): never {
  throw new FormatError(`${path}: ${message}`);
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isIndex = (key: string, max: number) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < max;

function checkValue(v: unknown, at: () => string): void {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(at(), `${v} is not a value`);
    return;
  }
  if (isObject(v) && typeof v.error === 'string' && Object.keys(v).length === 1) {
    if (!isErrorCode(v.error)) fail(at(), `'${v.error}' is not an error code`);
    return;
  }
  fail(
    at(),
    `${JSON.stringify(v)} is not a value (a number, a string, a boolean, null or { error })`,
  );
}

function checkZone(z: unknown, path: string, limits: Limits): void {
  if (!isObject(z)) fail(path, 'a zone is { top, left, bottom, right }');
  for (const k of ['top', 'left', 'bottom', 'right']) {
    if (!Number.isInteger(z[k]) || (z[k] as number) < 0)
      fail(`${path}.${k}`, 'a non-negative integer');
  }
  const { top, left, bottom, right } = z as unknown as Zone;
  if (top > bottom || left > right) fail(path, 'top-left after bottom-right');
  if (bottom >= limits.rows || right >= limits.cols) fail(path, 'outside the sheet');
}

/** Throws a sentence naming the first bad field; returns the data typed. */
export function validateWorkbook(data: unknown, limits: Limits = DEFAULT_LIMITS): CellsWorkbook {
  if (!isObject(data)) fail('workbook', 'a CellsWorkbook is a JSON object');
  if (data.version !== FORMAT_VERSION) {
    fail(
      'version',
      `this is format version ${JSON.stringify(data.version)}; Cells reads version ${FORMAT_VERSION}`,
    );
  }
  const styles = data.styles ?? [];
  if (!Array.isArray(styles)) fail('styles', 'a list');
  styles.forEach((s, i) => checkStyle(s, `styles[${i}]`));
  if (styles.length > 0 && Object.keys(styles[0] as object).length > 0)
    fail('styles[0]', 'style 0 is the default: {}');
  if (!Array.isArray(data.sheets) || data.sheets.length === 0) fail('sheets', 'a non-empty list');
  const ids = new Set<string>();
  const names = new Set<string>();
  data.sheets.forEach((sheet: unknown, i: number) => {
    const p = `sheets[${i}]`;
    if (!isObject(sheet)) fail(p, 'a sheet is an object');
    if (typeof sheet.id !== 'string' || sheet.id === '') fail(`${p}.id`, 'a non-empty string');
    if (ids.has(sheet.id)) fail(`${p}.id`, `'${sheet.id}' is used twice`);
    ids.add(sheet.id);
    if (typeof sheet.name !== 'string' || sheet.name.trim() === '')
      fail(`${p}.name`, 'a non-empty string');
    if (names.has(sheet.name.toLowerCase())) fail(`${p}.name`, `'${sheet.name}' is used twice`);
    names.add(sheet.name.toLowerCase());
    if (!isObject(sheet.rows)) fail(`${p}.rows`, 'an object keyed by row index');
    // Paths are built only for a refusal: a million cells validate without a string each.
    for (const r in sheet.rows) {
      const row = (sheet.rows as Record<string, unknown>)[r] as { cells?: unknown };
      const rp = () => `${p}.rows["${r}"]`;
      if (!isIndex(r, limits.rows)) fail(rp(), `'${r}' is not a row index below ${limits.rows}`);
      if (!isObject(row) || !isObject(row.cells)) fail(rp(), 'a row is { cells: { … } }');
      const cells = row.cells as Record<string, unknown>;
      for (const c in cells) {
        const cell = cells[c] as Record<string, unknown>;
        const cp = () => `${rp()}.cells["${c}"]`;
        if (!isIndex(c, limits.cols))
          fail(cp(), `'${c}' is not a column index below ${limits.cols}`);
        if (!isObject(cell)) fail(cp(), 'a cell is { v?, f?, s? }');
        for (const k in cell)
          if (k !== 'v' && k !== 'f' && k !== 's')
            fail(`${cp()}.${k}`, 'a cell has v, f and s only');
        if ('v' in cell) checkValue(cell.v, () => `${cp()}.v`);
        if ('f' in cell && (typeof cell.f !== 'string' || cell.f === ''))
          fail(`${cp()}.f`, 'a formula without the =');
        if (
          's' in cell &&
          (!Number.isInteger(cell.s) ||
            (cell.s as number) < 0 ||
            (cell.s as number) >= Math.max(1, styles.length))
        ) {
          fail(`${cp()}.s`, `no style ${JSON.stringify(cell.s)}`);
        }
      }
    }
    if (sheet.sizes !== undefined) {
      if (!isObject(sheet.sizes)) fail(`${p}.sizes`, '{ rows?, cols? }');
      for (const axis of ['rows', 'cols'] as const) {
        const sizes = sheet.sizes[axis];
        if (sizes === undefined) continue;
        if (!isObject(sizes)) fail(`${p}.sizes.${axis}`, 'an object keyed by index');
        for (const [k, v] of Object.entries(sizes)) {
          if (!isIndex(k, limits[axis]))
            fail(`${p}.sizes.${axis}["${k}"]`, 'not an index of the sheet');
          if (!(typeof v === 'number' && v > 0 && Number.isFinite(v)))
            fail(`${p}.sizes.${axis}["${k}"]`, 'a positive size');
        }
      }
    }
    if (sheet.hidden !== undefined) {
      if (!isObject(sheet.hidden)) fail(`${p}.hidden`, '{ rows?, cols? }');
      for (const axis of ['rows', 'cols'] as const) {
        const list = sheet.hidden[axis];
        if (list === undefined) continue;
        if (!Array.isArray(list)) fail(`${p}.hidden.${axis}`, 'a list of indexes');
        list.forEach((x, j) => {
          if (!Number.isInteger(x) || x < 0 || x >= limits[axis])
            fail(`${p}.hidden.${axis}[${j}]`, 'not an index of the sheet');
        });
      }
    }
    if (sheet.merges !== undefined) {
      if (!Array.isArray(sheet.merges)) fail(`${p}.merges`, 'a list of zones');
      sheet.merges.forEach((z: unknown, j: number) => checkZone(z, `${p}.merges[${j}]`, limits));
    }
    if (sheet.charts !== undefined) {
      if (!isObject(sheet.charts)) fail(`${p}.charts`, 'an object of charts by id');
      for (const [id, chart] of Object.entries(sheet.charts)) {
        const cp = `${p}.charts["${id}"]`;
        const spec = checkChart(chart, cp, limits);
        if (spec.id !== id)
          fail(`${cp}.id`, `the chart is filed under '${id}' and says '${spec.id}'`);
      }
    }
    if (sheet.code !== undefined) {
      if (!isObject(sheet.code)) fail(`${p}.code`, 'an object of code cells by cell (B4)');
      for (const [ref, code] of Object.entries(sheet.code)) {
        const cp = `${p}.code["${ref}"]`;
        const m = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref);
        let col = -1;
        if (m !== null) for (const ch of m[1]) col = (col + 1) * 26 + ch.charCodeAt(0) - 65;
        if (m === null || Number(m[2]) > limits.rows || col >= limits.cols)
          fail(cp, `'${ref}' is not a cell of the sheet`);
        const problem = codeProblem(code, cp);
        if (problem !== undefined) throw new FormatError(problem);
      }
    }
    if (sheet.dataSource !== undefined) {
      const d = sheet.dataSource as Record<string, unknown>;
      const dp = `${p}.dataSource`;
      if (!isObject(d)) fail(dp, '{ id, row, col, rows, cols }');
      if (typeof d.id !== 'string' || d.id === '') fail(`${dp}.id`, 'the id of a data source');
      for (const k of ['row', 'col', 'rows', 'cols'] as const)
        if (!Number.isInteger(d[k]) || (d[k] as number) < 0)
          fail(`${dp}.${k}`, 'a non-negative integer');
      for (const k of ['rows', 'cols'] as const)
        if ((d[k] as number) < 1) fail(`${dp}.${k}`, 'at least 1');
      if (
        (d.row as number) + (d.rows as number) > limits.rows ||
        (d.col as number) + (d.cols as number) > limits.cols
      )
        fail(dp, 'reaches outside the sheet');
    }
    if (sheet.frozen !== undefined) {
      const f = sheet.frozen;
      if (
        !isObject(f) ||
        !Number.isInteger(f.rows) ||
        !Number.isInteger(f.cols) ||
        (f.rows as number) < 0 ||
        (f.cols as number) < 0
      ) {
        fail(`${p}.frozen`, '{ rows, cols }, non-negative integers');
      }
    }
  });
  return data as unknown as CellsWorkbook;
}

const toValue = (v: JsonValue | undefined): CellValue =>
  v === undefined || v === null ? null : typeof v === 'object' ? cellError(v.error as never) : v;

const toJsonValue = (v: CellValue): JsonValue => (isCellError(v) ? { error: v.error } : v);

/** Fill an empty workbook from validated data (no patches, no history). */
export function loadInto(workbook: Workbook, data: unknown): void {
  if (workbook.sheets.length > 0) throw new Error('loadInto fills an empty workbook.');
  const wb = validateWorkbook(data, workbook.limits);
  const styleMap = (wb.styles ?? []).map((s) => workbook.styles.intern(s));
  for (const s of wb.sheets) {
    const sheet = workbook.createSheet(s.name, s.id);
    for (const r in s.rows) {
      const row = Number(r);
      const cells = s.rows[r].cells;
      for (const c in cells) {
        const cell = cells[c];
        const style = cell.s === undefined ? 0 : (styleMap[cell.s] ?? 0);
        const content: CellContent =
          cell.f === undefined
            ? { value: toValue(cell.v), style }
            : { value: toValue(cell.v), formula: cell.f, style };
        sheet.cells.set(row, Number(c), content);
      }
    }
    for (const axis of ['rows', 'cols'] as const) {
      const a = axis === 'rows' ? sheet.rows : sheet.cols;
      for (const [k, v] of Object.entries(s.sizes?.[axis] ?? {})) a.resize(Number(k), v);
      for (const i of s.hidden?.[axis] ?? []) a.setHidden(i, true);
    }
    sheet.merges = (s.merges ?? []).map((z) => ({ ...z }));
    for (const [id, chart] of Object.entries(s.charts ?? {})) sheet.charts.set(id, chart);
    for (const [ref, code] of Object.entries(s.code ?? {})) {
      const m = /^([A-Z]+)([0-9]+)$/.exec(ref)!;
      let col = -1;
      for (const ch of m[1]) col = (col + 1) * 26 + ch.charCodeAt(0) - 65;
      sheet.code.set(codeKey(sheet, Number(m[2]) - 1, col), code);
    }
    sheet.frozen = s.frozen ? { rows: s.frozen.rows, cols: s.frozen.cols } : { rows: 0, cols: 0 };
    sheet.dataSource = s.dataSource
      ? {
          id: s.dataSource.id,
          at: { row: s.dataSource.row, col: s.dataSource.col },
          rows: s.dataSource.rows,
          cols: s.dataSource.cols,
        }
      : null;
    workbook.sheets.push(sheet);
  }
}

/** The workbook as `CellsWorkbook` JSON. */
export function toJSON(workbook: Workbook): CellsWorkbook {
  const used = new Map<number, number>([[0, 0]]);
  const styles: Style[] = [{}];
  const styleIndex = (i: number) => {
    let j = used.get(i);
    if (j === undefined) {
      j = styles.length;
      styles.push(workbook.styles.get(i));
      used.set(i, j);
    }
    return j;
  };
  const sheets = workbook.sheets.map((sheet): CellsSheet => {
    const rows: Record<string, { cells: Record<string, CellsCell> }> = {};
    // A data source's rows are read, never saved: the cells of its zone stay out of the file.
    const bound = boundZone(sheet);
    const entries = [...sheet.cells.entries()]
      .filter(([row, col]) => bound === undefined || !zoneContains(bound, { row, col }))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [row, col, c] of entries) {
      const cell: { v?: JsonValue; f?: string; s?: number } = {};
      if (c.value !== null) cell.v = toJsonValue(c.value);
      if (c.formula !== undefined) cell.f = c.formula;
      if (c.style !== 0) cell.s = styleIndex(c.style);
      (rows[row] ??= { cells: {} }).cells[col] = cell;
    }
    const out: { -readonly [K in keyof CellsSheet]: CellsSheet[K] } = {
      id: sheet.id,
      name: sheet.name,
      rows,
    };
    const sizes: { rows?: Record<string, number>; cols?: Record<string, number> } = {};
    const hidden: { rows?: number[]; cols?: number[] } = {};
    for (const axis of ['rows', 'cols'] as const) {
      const a = axis === 'rows' ? sheet.rows : sheet.cols;
      const s = axisSizes(a);
      if (Object.keys(s.sizes).length > 0) sizes[axis] = s.sizes;
      if (s.hidden.length > 0) hidden[axis] = s.hidden;
    }
    if (Object.keys(sizes).length > 0) out.sizes = sizes;
    if (Object.keys(hidden).length > 0) out.hidden = hidden;
    if (sheet.merges.length > 0) out.merges = sheet.merges.map((z) => ({ ...z }));
    if (sheet.frozen.rows > 0 || sheet.frozen.cols > 0) out.frozen = { ...sheet.frozen };
    if (sheet.charts.size > 0) out.charts = Object.fromEntries(sheet.charts);
    const code: Record<string, CodeCell> = {};
    for (const [key, c] of sheet.code) {
      const at = codePosition(sheet, key);
      if (at !== undefined) code[codeRef(at.row, at.col)] = c;
    }
    if (Object.keys(code).length > 0)
      out.code = Object.fromEntries(Object.entries(code).sort(([a], [b]) => a.localeCompare(b)));
    if (sheet.dataSource !== null)
      out.dataSource = {
        id: sheet.dataSource.id,
        row: sheet.dataSource.at.row,
        col: sheet.dataSource.at.col,
        rows: sheet.dataSource.rows,
        cols: sheet.dataSource.cols,
      };
    return out;
  });
  return { version: FORMAT_VERSION, sheets, styles };
}

function axisSizes(a: Workbook['sheets'][number]['rows']): {
  sizes: Record<string, number>;
  hidden: number[];
} {
  const sizes: Record<string, number> = {};
  const hidden: number[] = [];
  // Only an axis that ever changed size has its arrays; walk it only then.
  if (!a.customized) return { sizes, hidden };
  for (let i = 0; i < a.count; i += 1) {
    const s = a.sizeOf(i);
    if (s !== a.defaultSize) sizes[i] = s;
    if (a.isHidden(i)) hidden.push(i);
  }
  return { sizes, hidden };
}

/** A workbook of one sheet from rows of values: the convenience for small tables. */
export function fromRows(rows: readonly (readonly CellValue[])[], name = 'Sheet1'): CellsWorkbook {
  const out: Record<string, { cells: Record<string, CellsCell> }> = {};
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === null || v === undefined) return;
      (out[r] ??= { cells: {} }).cells[c] = { v: toJsonValue(v) };
    }),
  );
  return { version: FORMAT_VERSION, sheets: [{ id: 's1', name, rows: out }], styles: [] };
}
