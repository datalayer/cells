/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Charts as data (§3.12): a sheet holds its charts as persisted state, like
 * its merges. A chart is a `ChartSpec`: a type, an anchor (DrawingML's three,
 * so XLSX maps one to one), and series whose ranges are A1 references, so the
 * structural rewrite of formulas moves them. Drawing a chart is `./charts`;
 * this module imports nothing of it.
 *
 * Here: the spec and its validation (a bad field refused with its path), the
 * `chart` patch op, the five commands, inference of a chart from a selection,
 * and the refusals `ChartTooLarge` and `NoNumericData`.
 *
 * @module core/charts
 */

import type { Ast } from '../formula/ast.js';
import { parseFormula } from '../formula/parser.js';
import { type CommandContext, type CommandResult, OK, refuse } from './commands.js';
import type { Patch, PatchOp } from './patches.js';
import type { CommandHandler } from '../points/index.js';
import type { CellValue } from './values.js';
import type { Limits, Workbook } from './workbook.js';
import { columnLetters, type Zone } from './zone.js';

/** A range or a cell in A1 form, its sheet named when it is another (`Sheet1!$B$2:$B$13`). */
export type Ref = string;

/** A corner of a chart in a cell: the cell, and px from its top-left corner. */
export interface CellOffset {
  readonly row: number;
  readonly col: number;
  readonly dx: number;
  readonly dy: number;
}

export type ChartAnchor =
  /** Moves and sizes with the cells under it. */
  | { readonly kind: 'cells'; readonly from: CellOffset; readonly to: CellOffset }
  /** Moves with its cell, a fixed size in px. */
  | {
      readonly kind: 'cell';
      readonly from: CellOffset;
      readonly width: number;
      readonly height: number;
    }
  /** Fixed in the sheet, in px. */
  | {
      readonly kind: 'absolute';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export interface ChartAxis {
  readonly title?: string;
  readonly min?: number;
  readonly max?: number;
  readonly format?: string;
  readonly log?: boolean;
  readonly gridlines?: boolean;
}

export interface ChartSeries {
  /** Its name, given or read from a cell. */
  readonly name?: Ref | string;
  readonly values: Ref;
  readonly categories?: Ref;
  /** Scatter's x values. */
  readonly x?: Ref;
  /** In a combo, how this series draws. */
  readonly type?: 'column' | 'line' | 'area';
  readonly axis?: 'primary' | 'secondary';
  readonly color?: string;
}

export const BUILTIN_CHART_TYPES = [
  'bar',
  'column',
  'line',
  'area',
  'pie',
  'scatter',
  'combo',
] as const;
export const CHART_VARIANTS = ['clustered', 'stacked', 'percent', 'smooth', 'doughnut'] as const;
const LEGENDS = ['top', 'right', 'bottom', 'left', 'none'] as const;

export interface ChartSpec {
  readonly id: string;
  /** A built-in type, or a type a plugin contributes, by id. */
  readonly type: string;
  readonly variant?: (typeof CHART_VARIANTS)[number];
  readonly anchor: ChartAnchor;
  readonly data: {
    readonly series: readonly ChartSeries[];
    /** How the source range was split into series. */
    readonly by: 'columns' | 'rows';
    readonly headers: { readonly row: boolean; readonly column: boolean };
    readonly blanks: 'gap' | 'zero' | 'connect';
  };
  readonly title?: string;
  readonly legend: (typeof LEGENDS)[number];
  readonly axes?: { readonly x?: ChartAxis; readonly y?: ChartAxis; readonly y2?: ChartAxis };
  /** Data labels on or off. */
  readonly labels?: boolean;
}

/** The most points a chart holds; inserting a bigger one is refused. */
export const MAX_CHART_POINTS = 100_000;

// ------------------------------------------------------------------ validation

class ChartError extends Error {}

function fail(path: string, message: string): never {
  throw new ChartError(`${path}: ${message}`);
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** A reference's AST: a cell or a range (or `#REF!`, once its cells were deleted); else `undefined`. */
export function refAst(ref: string): Ast | undefined {
  let ast: Ast;
  try {
    ast = parseFormula(ref).ast;
  } catch {
    return undefined;
  }
  if (ast.type === 'cell' || ast.type === 'range') return ast;
  if (ast.type === 'error' && ast.code === '#REF!') return ast;
  return undefined;
}

function checkRef(v: unknown, path: string): void {
  if (typeof v !== 'string' || refAst(v) === undefined) fail(path, 'not a range');
}

function checkOffset(v: unknown, path: string, limits: Limits): void {
  if (!isObject(v)) fail(path, 'a cell offset is { row, col, dx, dy }');
  for (const k of ['row', 'col'] as const)
    if (!Number.isInteger(v[k]) || (v[k] as number) < 0)
      fail(`${path}.${k}`, 'a non-negative integer');
  if ((v.row as number) >= limits.rows || (v.col as number) >= limits.cols)
    fail(path, 'outside the sheet');
  for (const k of ['dx', 'dy'] as const)
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k]) || (v[k] as number) < 0)
      fail(`${path}.${k}`, 'a non-negative number of px');
}

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function checkAxis(v: unknown, path: string): void {
  if (!isObject(v)) fail(path, 'an axis is { title?, min?, max?, format?, log?, gridlines? }');
  for (const k of Object.keys(v))
    if (!['title', 'min', 'max', 'format', 'log', 'gridlines'].includes(k))
      fail(`${path}.${k}`, 'not a field of an axis');
  if (v.title !== undefined && typeof v.title !== 'string') fail(`${path}.title`, 'a text');
  for (const k of ['min', 'max'] as const)
    if (v[k] !== undefined && (typeof v[k] !== 'number' || !Number.isFinite(v[k])))
      fail(`${path}.${k}`, 'a number');
  if (v.format !== undefined && typeof v.format !== 'string')
    fail(`${path}.format`, 'a number format');
  for (const k of ['log', 'gridlines'] as const)
    if (v[k] !== undefined && typeof v[k] !== 'boolean') fail(`${path}.${k}`, 'true or false');
}

/**
 * Throw a sentence naming the first bad field of a chart (`path` is where it
 * sits: `sheets[0].charts["c3"]` in a file); returns it typed.
 */
export function checkChart(v: unknown, path: string, limits: Limits): ChartSpec {
  if (!isObject(v)) fail(path, 'a chart is an object');
  for (const k of Object.keys(v))
    if (
      !['id', 'type', 'variant', 'anchor', 'data', 'title', 'legend', 'axes', 'labels'].includes(k)
    )
      fail(`${path}.${k}`, 'not a field of a chart');
  if (typeof v.id !== 'string' || v.id === '') fail(`${path}.id`, 'a non-empty string');
  if (typeof v.type !== 'string' || !/^[a-z][a-zA-Z0-9.-]*$/.test(v.type))
    fail(`${path}.type`, 'a chart type (column, line, … or a contributed type)');
  if (v.variant !== undefined && !(CHART_VARIANTS as readonly unknown[]).includes(v.variant))
    fail(`${path}.variant`, `one of ${CHART_VARIANTS.join(', ')}`);
  const a = v.anchor;
  if (!isObject(a)) fail(`${path}.anchor`, 'an anchor is { kind, … }');
  if (a.kind === 'cells') {
    checkOffset(a.from, `${path}.anchor.from`, limits);
    checkOffset(a.to, `${path}.anchor.to`, limits);
    const from = a.from as unknown as CellOffset;
    const to = a.to as unknown as CellOffset;
    if (to.row < from.row || to.col < from.col) fail(`${path}.anchor`, 'from after to');
  } else if (a.kind === 'cell') {
    checkOffset(a.from, `${path}.anchor.from`, limits);
    if (!positive(a.width)) fail(`${path}.anchor.width`, 'a positive number of px');
    if (!positive(a.height)) fail(`${path}.anchor.height`, 'a positive number of px');
  } else if (a.kind === 'absolute') {
    for (const k of ['x', 'y'] as const)
      if (typeof a[k] !== 'number' || !Number.isFinite(a[k]) || (a[k] as number) < 0)
        fail(`${path}.anchor.${k}`, 'a non-negative number of px');
    if (!positive(a.width)) fail(`${path}.anchor.width`, 'a positive number of px');
    if (!positive(a.height)) fail(`${path}.anchor.height`, 'a positive number of px');
  } else fail(`${path}.anchor.kind`, 'cells, cell or absolute');
  const d = v.data;
  if (!isObject(d)) fail(`${path}.data`, 'the data is { series, by, headers, blanks }');
  if (!Array.isArray(d.series) || d.series.length === 0)
    fail(`${path}.data.series`, 'a non-empty list');
  d.series.forEach((s: unknown, i: number) => {
    const sp = `${path}.data.series[${i}]`;
    if (!isObject(s)) fail(sp, 'a series is { values, … }');
    for (const k of Object.keys(s))
      if (!['name', 'values', 'categories', 'x', 'type', 'axis', 'color'].includes(k))
        fail(`${sp}.${k}`, 'not a field of a series');
    checkRef(s.values, `${sp}.values`);
    if (s.categories !== undefined) checkRef(s.categories, `${sp}.categories`);
    if (s.x !== undefined) checkRef(s.x, `${sp}.x`);
    if (s.name !== undefined && typeof s.name !== 'string') fail(`${sp}.name`, 'a text or a range');
    if (s.type !== undefined && !['column', 'line', 'area'].includes(s.type as string))
      fail(`${sp}.type`, 'column, line or area');
    if (s.axis !== undefined && s.axis !== 'primary' && s.axis !== 'secondary')
      fail(`${sp}.axis`, 'primary or secondary');
    if (
      s.color !== undefined &&
      (typeof s.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.color))
    )
      fail(`${sp}.color`, 'a colour such as #1f77b4');
  });
  if (d.by !== 'columns' && d.by !== 'rows') fail(`${path}.data.by`, 'columns or rows');
  if (
    !isObject(d.headers) ||
    typeof d.headers.row !== 'boolean' ||
    typeof d.headers.column !== 'boolean'
  )
    fail(`${path}.data.headers`, '{ row, column }, true or false each');
  if (!['gap', 'zero', 'connect'].includes(d.blanks as string))
    fail(`${path}.data.blanks`, 'gap, zero or connect');
  if (v.title !== undefined && typeof v.title !== 'string')
    fail(`${path}.title`, 'a text or a range');
  if (!(LEGENDS as readonly unknown[]).includes(v.legend))
    fail(`${path}.legend`, `one of ${LEGENDS.join(', ')}`);
  if (v.axes !== undefined) {
    if (!isObject(v.axes)) fail(`${path}.axes`, '{ x?, y?, y2? }');
    for (const k of Object.keys(v.axes)) {
      if (!['x', 'y', 'y2'].includes(k)) fail(`${path}.axes.${k}`, 'not an axis (x, y or y2)');
      checkAxis(v.axes[k], `${path}.axes.${k}`);
    }
  }
  if (v.labels !== undefined && typeof v.labels !== 'boolean')
    fail(`${path}.labels`, 'true or false');
  return v as unknown as ChartSpec;
}

/** The validation's sentence, or `undefined` when the chart is good. */
export function chartProblem(v: unknown, limits: Limits, path = 'chart'): string | undefined {
  try {
    checkChart(v, path, limits);
    return undefined;
  } catch (error) {
    if (error instanceof ChartError) return error.message;
    throw error;
  }
}

// ------------------------------------------------------------------ reading ranges

/** The sheet and zone a reference names, from a chart on `sheet`; `undefined` for `#REF!` or an unknown sheet. */
export function refZone(
  workbook: Workbook,
  sheet: string,
  ref: string,
): { sheet: string; zone: Zone } | undefined {
  const ast = refAst(ref);
  if (ast === undefined || ast.type === 'error') return undefined;
  const target =
    ast.type === 'cell' || ast.type === 'range'
      ? ast.sheet === undefined
        ? sheet
        : workbook.sheetByName(ast.sheet)?.id
      : undefined;
  if (target === undefined) return undefined;
  const s = workbook.sheet(target);
  if (ast.type === 'cell') {
    const { row, col } = ast.ref;
    if (row === undefined || col === undefined) return undefined;
    return { sheet: target, zone: { top: row, left: col, bottom: row, right: col } };
  }
  if (ast.type !== 'range') return undefined;
  const r0 = ast.from.row ?? 0;
  const r1 = ast.to.row ?? s.rows.count - 1;
  const c0 = ast.from.col ?? 0;
  const c1 = ast.to.col ?? s.cols.count - 1;
  return {
    sheet: target,
    zone: {
      top: Math.min(r0, r1),
      left: Math.min(c0, c1),
      bottom: Math.max(r0, r1),
      right: Math.max(c0, c1),
    },
  };
}

const cellsOf = (z: Zone) => (z.bottom - z.top + 1) * (z.right - z.left + 1);

/** The references of a chart: every range it reads (values, categories, x, and a name read from a cell). */
export function chartRefs(spec: ChartSpec): Ref[] {
  const refs: Ref[] = [];
  for (const s of spec.data.series) {
    refs.push(s.values);
    if (s.categories !== undefined) refs.push(s.categories);
    if (s.x !== undefined) refs.push(s.x);
    if (s.name !== undefined && refAst(s.name) !== undefined) refs.push(s.name);
  }
  return refs;
}

/**
 * The ranges a chart reads, resolved to sheets and zones: what the engine
 * registers as the chart's precedents (§3.12). A `#REF!` range reads nothing.
 */
export function chartRanges(
  workbook: Workbook,
  sheet: string,
  spec: ChartSpec,
): { sheet: string; zone: Zone }[] {
  const out: { sheet: string; zone: Zone }[] = [];
  for (const ref of chartRefs(spec)) {
    const r = refZone(workbook, sheet, ref);
    if (r !== undefined) out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ the data

/** One series as a chart draws it: numbers, with `null` for a gap. */
export interface ChartSeriesData {
  readonly name: string;
  readonly values: readonly (number | null)[];
  /** Scatter's x values, as long as `values`. */
  readonly x?: readonly (number | null)[];
  readonly type?: 'column' | 'line' | 'area';
  readonly axis?: 'primary' | 'secondary';
  readonly color?: string;
  /** The range the values came from, for the description and *Show chart data*; `undefined` once deleted. */
  readonly source?: Ref;
}

/** What a chart draws: the categories (of the first series naming some), and its series. */
export interface ChartData {
  readonly categories: readonly (string | number)[];
  readonly series: readonly ChartSeriesData[];
  /** The ranges that are `#REF!`: the chart draws an empty frame naming them. */
  readonly deleted: readonly Ref[];
}

/** The cells of a zone in reading order: a column top down, a row left to right, a rectangle row by row. */
function* cellsIn(z: Zone): IterableIterator<[number, number]> {
  for (let r = z.top; r <= z.bottom; r += 1)
    for (let c = z.left; c <= z.right; c += 1) yield [r, c];
}

/**
 * The data of a chart, a pure function of the model's values: each series'
 * numbers in reading order, with a gap (`null`) for an empty cell (or 0 when
 * `blanks` is `zero`), a text, a boolean or an error (`#BUSY!` included: a
 * cell still being fetched draws as a gap, then as its value). A series' name
 * is its text, or the text of the cell it names, or "Series n".
 */
export function chartData(
  read: (sheet: string, row: number, col: number) => CellValue,
  workbook: Workbook,
  sheet: string,
  spec: ChartSpec,
): ChartData {
  const deleted: Ref[] = [];
  const numbers = (ref: Ref | undefined): (number | null)[] | undefined => {
    if (ref === undefined) return undefined;
    const r = refZone(workbook, sheet, ref);
    if (r === undefined) {
      deleted.push(ref);
      return [];
    }
    const out: (number | null)[] = [];
    for (const [row, col] of cellsIn(r.zone)) {
      const v = read(r.sheet, row, col);
      if (typeof v === 'number') out.push(v);
      else out.push(v === null && spec.data.blanks === 'zero' ? 0 : null);
    }
    return out;
  };
  const labels = (ref: Ref): (string | number)[] => {
    const r = refZone(workbook, sheet, ref);
    if (r === undefined) {
      deleted.push(ref);
      return [];
    }
    const out: (string | number)[] = [];
    for (const [row, col] of cellsIn(r.zone)) {
      const v = read(r.sheet, row, col);
      out.push(typeof v === 'number' || typeof v === 'string' ? v : v === null ? '' : String(v));
    }
    return out;
  };
  let categories: (string | number)[] | undefined;
  const series = spec.data.series.map((s, i) => {
    if (categories === undefined && s.categories !== undefined) categories = labels(s.categories);
    let name = `Series ${i + 1}`;
    if (s.name !== undefined) {
      if (refAst(s.name) === undefined) name = s.name;
      else {
        const r = refZone(workbook, sheet, s.name);
        if (r === undefined) deleted.push(s.name);
        else {
          const v = read(r.sheet, r.zone.top, r.zone.left);
          if (v !== null && typeof v !== 'object') name = String(v);
        }
      }
    }
    const values = numbers(s.values)!;
    const x = numbers(s.x);
    const deletedValues = refZone(workbook, sheet, s.values) === undefined;
    return {
      name,
      values,
      ...(x !== undefined ? { x } : {}),
      ...(s.type !== undefined ? { type: s.type } : {}),
      ...(s.axis !== undefined ? { axis: s.axis } : {}),
      ...(s.color !== undefined ? { color: s.color } : {}),
      ...(deletedValues ? {} : { source: s.values }),
    };
  });
  return { categories: categories ?? [], series, deleted: [...new Set(deleted)] };
}

/** How many points a chart draws: the cells of its value ranges. */
export function chartPoints(workbook: Workbook, sheet: string, spec: ChartSpec): number {
  let n = 0;
  for (const s of spec.data.series) {
    const r = refZone(workbook, sheet, s.values);
    if (r !== undefined) n += cellsOf(r.zone);
  }
  return n;
}

/** Whether the value ranges hold a number anywhere. */
function hasNumber(context: CommandContext, sheet: string, spec: ChartSpec): boolean {
  for (const s of spec.data.series) {
    const r = refZone(context.workbook, sheet, s.values);
    if (r === undefined) continue;
    for (const [row, col] of context.workbook.sheet(r.sheet).cells.entries(r.zone))
      if (typeof context.value(r.sheet, row, col) === 'number') return true;
  }
  return false;
}

// ------------------------------------------------------------------ inference

/** A1 text of a zone, its sheet named and its corners anchored. */
export function zoneRef(sheetName: string, z: Zone): Ref {
  const quoted =
    /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheetName) && !/^[A-Za-z]{1,3}[0-9]+$/.test(sheetName)
      ? sheetName
      : `'${sheetName.replace(/'/g, "''")}'`;
  const a = `$${columnLetters(z.left)}$${z.top + 1}`;
  const b = `$${columnLetters(z.right)}$${z.bottom + 1}`;
  return `${quoted}!${a === b ? a : `${a}:${b}`}`;
}

/**
 * The data of a chart inferred from a selection, as Excel and Sheets infer
 * it: a first row of text over numbers names the series, a first column of
 * text or dates holds the categories, more rows than columns gives series by
 * columns (one column is one series), and a selection with no number is
 * refused (`NoNumericData`), as is one past `MAX_CHART_POINTS` (`ChartTooLarge`).
 */
export function inferChartData(
  read: (row: number, col: number) => CellValue,
  sheetName: string,
  zone: Zone,
  isDate: (row: number, col: number) => boolean = () => false,
):
  | { ok: true; data: ChartSpec['data'] }
  | { ok: false; reason: 'NoNumericData' | 'ChartTooLarge'; message: string } {
  const rows = zone.bottom - zone.top + 1;
  const cols = zone.right - zone.left + 1;
  const isText = (r: number, c: number) => typeof read(r, c) === 'string';
  const isNumber = (r: number, c: number) => typeof read(r, c) === 'number' && !isDate(r, c);
  let numbers = 0;
  for (let r = zone.top; r <= zone.bottom; r += 1)
    for (let c = zone.left; c <= zone.right; c += 1) if (isNumber(r, c)) numbers += 1;
  if (numbers === 0)
    return {
      ok: false,
      reason: 'NoNumericData',
      message: 'The selection holds no number to chart.',
    };
  // A first row of text (past a corner cell) names series; a first column of text or dates holds categories.
  let headerRow = rows > 1;
  for (let c = zone.left + (cols > 1 ? 1 : 0); c <= zone.right && headerRow; c += 1)
    if (!(isText(zone.top, c) || read(zone.top, c) === null)) headerRow = false;
  if (headerRow) {
    let any = false;
    for (let c = zone.left; c <= zone.right; c += 1) if (isText(zone.top, c)) any = true;
    headerRow = any;
  }
  let headerColumn = cols > 1;
  for (let r = zone.top + (headerRow ? 1 : 0); r <= zone.bottom && headerColumn; r += 1)
    if (!(isText(r, zone.left) || isDate(r, zone.left) || read(r, zone.left) === null))
      headerColumn = false;
  const body: Zone = {
    top: zone.top + (headerRow ? 1 : 0),
    left: zone.left + (headerColumn ? 1 : 0),
    bottom: zone.bottom,
    right: zone.right,
  };
  if (body.top > body.bottom || body.left > body.right)
    return {
      ok: false,
      reason: 'NoNumericData',
      message: 'The selection holds no number to chart.',
    };
  const points = cellsOf(body);
  if (points > MAX_CHART_POINTS)
    return {
      ok: false,
      reason: 'ChartTooLarge',
      message: `A chart holds at most ${MAX_CHART_POINTS.toLocaleString('en-US')} points; this selection has ${points.toLocaleString('en-US')}.`,
    };
  const byColumns = body.bottom - body.top >= body.right - body.left;
  const series: ChartSeries[] = [];
  if (byColumns) {
    for (let c = body.left; c <= body.right; c += 1)
      series.push({
        values: zoneRef(sheetName, { top: body.top, left: c, bottom: body.bottom, right: c }),
        ...(headerRow
          ? { name: zoneRef(sheetName, { top: zone.top, left: c, bottom: zone.top, right: c }) }
          : {}),
        ...(headerColumn
          ? {
              categories: zoneRef(sheetName, {
                top: body.top,
                left: zone.left,
                bottom: body.bottom,
                right: zone.left,
              }),
            }
          : {}),
      });
  } else {
    for (let r = body.top; r <= body.bottom; r += 1)
      series.push({
        values: zoneRef(sheetName, { top: r, left: body.left, bottom: r, right: body.right }),
        ...(headerColumn
          ? { name: zoneRef(sheetName, { top: r, left: zone.left, bottom: r, right: zone.left }) }
          : {}),
        ...(headerRow
          ? {
              categories: zoneRef(sheetName, {
                top: zone.top,
                left: body.left,
                bottom: zone.top,
                right: body.right,
              }),
            }
          : {}),
      });
  }
  return {
    ok: true,
    data: {
      series,
      by: byColumns ? 'columns' : 'rows',
      headers: { row: headerRow, column: headerColumn },
      blanks: 'gap',
    },
  };
}

// ------------------------------------------------------------------ the patch op

export interface ChartPatch {
  readonly op: 'chart';
  readonly sheet: string;
  readonly id: string;
  readonly before: ChartSpec | null;
  readonly after: ChartSpec | null;
}

export const chartOp: PatchOp<ChartPatch> = {
  op: 'chart',
  apply(wb, p) {
    const s = wb.sheet(p.sheet);
    if (p.after === null) s.charts.delete(p.id);
    else s.charts.set(p.id, p.after);
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  bytes: () => 512,
  example: () => ({
    op: 'chart',
    sheet: 's1',
    id: 'c1',
    before: null,
    after: {
      id: 'c1',
      type: 'column',
      anchor: {
        kind: 'cells',
        from: { row: 1, col: 4, dx: 0, dy: 0 },
        to: { row: 10, col: 9, dx: 0, dy: 0 },
      },
      data: {
        series: [{ values: 'Sheet1!$B$2:$B$5' }],
        by: 'columns',
        headers: { row: false, column: false },
        blanks: 'gap',
      },
      legend: 'bottom',
    },
  }),
};

// ------------------------------------------------------------------ commands

export interface InsertChartCommand {
  readonly type: 'INSERT_CHART';
  readonly sheet: string;
  /** The chart; its id is made when absent. */
  readonly chart: Omit<ChartSpec, 'id'> & { readonly id?: string };
}
export interface UpdateChartCommand {
  readonly type: 'UPDATE_CHART';
  readonly sheet: string;
  readonly id: string;
  /** The fields that change: type, variant, data, title, legend, axes, labels. */
  readonly changes: Partial<Omit<ChartSpec, 'id' | 'anchor'>>;
}
export interface MoveChartCommand {
  readonly type: 'MOVE_CHART';
  readonly sheet: string;
  readonly id: string;
  /** Where its top-left corner goes: a cell (cell anchors keep their size, in cells or px), or px (absolute). */
  readonly to:
    { readonly row: number; readonly col: number } | { readonly x: number; readonly y: number };
}
export interface ResizeChartCommand {
  readonly type: 'RESIZE_CHART';
  readonly sheet: string;
  readonly id: string;
  /** A cells anchor's new bottom-right cell; or a size in px for the others. */
  readonly to:
    | { readonly row: number; readonly col: number }
    | { readonly width: number; readonly height: number };
}
export interface DeleteChartCommand {
  readonly type: 'DELETE_CHART';
  readonly sheet: string;
  readonly id: string;
}

export type ChartCommand =
  | InsertChartCommand
  | UpdateChartCommand
  | MoveChartCommand
  | ResizeChartCommand
  | DeleteChartCommand;

function sheetOf(context: CommandContext, sheet: string): CommandResult | undefined {
  return context.workbook.hasSheet(sheet)
    ? undefined
    : refuse('UnknownSheet', `No sheet '${sheet}'.`);
}

function chartOf(context: CommandContext, sheet: string, id: string): ChartSpec | CommandResult {
  const missing = sheetOf(context, sheet);
  if (missing) return missing;
  return (
    context.workbook.sheet(sheet).charts.get(id) ??
    refuse('UnknownChart', `No chart '${id}' on this sheet.`)
  );
}

const isResult = (x: unknown): x is CommandResult =>
  typeof x === 'object' &&
  x !== null &&
  'ok' in x &&
  typeof (x as { ok: unknown }).ok === 'boolean';

/** A chart's refusals beyond its shape: too many points, or no number to draw. */
function contentRefusal(context: CommandContext, sheet: string, spec: ChartSpec): CommandResult {
  const problem = chartProblem(spec, context.workbook.limits);
  if (problem !== undefined) return refuse('InvalidArgument', problem);
  const points = chartPoints(context.workbook, sheet, spec);
  if (points > MAX_CHART_POINTS)
    return refuse(
      'ChartTooLarge',
      `A chart holds at most ${MAX_CHART_POINTS.toLocaleString('en-US')} points; this one has ${points.toLocaleString('en-US')}.`,
    );
  if (!hasNumber(context, sheet, spec))
    return refuse('NoNumericData', 'The chart’s ranges hold no number to draw.');
  return OK;
}

function freshChartId(context: CommandContext, sheet: string): string {
  const charts = context.workbook.sheet(sheet).charts;
  for (let i = 1; ; i += 1) if (!charts.has(`chart${i}`)) return `chart${i}`;
}

const patch = (
  sheet: string,
  id: string,
  before: ChartSpec | null,
  after: ChartSpec | null,
): Patch => ({ op: 'chart', sheet, id, before, after }) as ChartPatch as unknown as Patch;

/** The spec an insert writes: its id given or made. Commands are replayed, so the id is fixed at `allow`'s first sight. */
function inserted(context: CommandContext, c: InsertChartCommand): ChartSpec {
  return { ...c.chart, id: c.chart.id ?? freshChartId(context, c.sheet) } as ChartSpec;
}

const insertChart: CommandHandler<InsertChartCommand> = {
  type: 'INSERT_CHART',
  allow: (context, c) => {
    const missing = sheetOf(context, c.sheet);
    if (missing) return missing;
    const spec = inserted(context, c);
    if (context.workbook.sheet(c.sheet).charts.has(spec.id))
      return refuse('DuplicateChart', `A chart '${spec.id}' is on this sheet already.`);
    return contentRefusal(context, c.sheet, spec);
  },
  apply: (context, c) => {
    const spec = inserted(context, c);
    return [patch(c.sheet, spec.id, null, spec)];
  },
};

const updateChart: CommandHandler<UpdateChartCommand> = {
  type: 'UPDATE_CHART',
  allow: (context, c) => {
    const spec = chartOf(context, c.sheet, c.id);
    if (isResult(spec)) return spec;
    if ('id' in c.changes || 'anchor' in c.changes)
      return refuse(
        'InvalidArgument',
        'An update changes neither the id nor the anchor (MOVE_CHART, RESIZE_CHART).',
      );
    return contentRefusal(context, c.sheet, { ...spec, ...c.changes } as ChartSpec);
  },
  apply: (context, c) => {
    const spec = context.workbook.sheet(c.sheet).charts.get(c.id)!;
    return [patch(c.sheet, c.id, spec, { ...spec, ...c.changes } as ChartSpec)];
  },
};

function moved(spec: ChartSpec, to: MoveChartCommand['to']): ChartAnchor | string {
  const a = spec.anchor;
  if (a.kind === 'absolute') {
    if (!('x' in to)) return 'An absolute chart moves to px (x, y), not to a cell.';
    return { ...a, x: to.x, y: to.y };
  }
  if (!('row' in to)) return 'A chart anchored on cells moves to a cell (row, col), not to px.';
  if (a.kind === 'cell') return { ...a, from: { ...a.from, row: to.row, col: to.col } };
  return {
    ...a,
    from: { ...a.from, row: to.row, col: to.col },
    to: { ...a.to, row: to.row + (a.to.row - a.from.row), col: to.col + (a.to.col - a.from.col) },
  };
}

const moveChart: CommandHandler<MoveChartCommand> = {
  type: 'MOVE_CHART',
  allow: (context, c) => {
    const spec = chartOf(context, c.sheet, c.id);
    if (isResult(spec)) return spec;
    const anchor = moved(spec, c.to);
    if (typeof anchor === 'string') return refuse('InvalidArgument', anchor);
    const problem = chartProblem({ ...spec, anchor }, context.workbook.limits);
    return problem === undefined ? OK : refuse('InvalidArgument', problem);
  },
  apply: (context, c) => {
    const spec = context.workbook.sheet(c.sheet).charts.get(c.id)!;
    return [patch(c.sheet, c.id, spec, { ...spec, anchor: moved(spec, c.to) as ChartAnchor })];
  },
};

function resized(spec: ChartSpec, to: ResizeChartCommand['to']): ChartAnchor | string {
  const a = spec.anchor;
  if (a.kind === 'cells') {
    if (!('row' in to)) return 'A chart anchored on cells is resized to a cell (row, col).';
    return { ...a, to: { ...a.to, row: to.row, col: to.col } };
  }
  if (!('width' in to)) return 'This chart is resized in px (width, height).';
  return { ...a, width: to.width, height: to.height };
}

const resizeChart: CommandHandler<ResizeChartCommand> = {
  type: 'RESIZE_CHART',
  allow: (context, c) => {
    const spec = chartOf(context, c.sheet, c.id);
    if (isResult(spec)) return spec;
    const anchor = resized(spec, c.to);
    if (typeof anchor === 'string') return refuse('InvalidArgument', anchor);
    const problem = chartProblem({ ...spec, anchor }, context.workbook.limits);
    return problem === undefined ? OK : refuse('InvalidArgument', problem);
  },
  apply: (context, c) => {
    const spec = context.workbook.sheet(c.sheet).charts.get(c.id)!;
    return [patch(c.sheet, c.id, spec, { ...spec, anchor: resized(spec, c.to) as ChartAnchor })];
  },
};

const deleteChart: CommandHandler<DeleteChartCommand> = {
  type: 'DELETE_CHART',
  allow: (context, c) => {
    const spec = chartOf(context, c.sheet, c.id);
    return isResult(spec) ? spec : OK;
  },
  apply: (context, c) => {
    const spec = context.workbook.sheet(c.sheet).charts.get(c.id)!;
    return [patch(c.sheet, c.id, spec, null)];
  },
};

export const CHART_COMMANDS: readonly CommandHandler<any>[] = [
  insertChart,
  updateChart,
  moveChart,
  resizeChart,
  deleteChart,
];
