/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Code cells (§3.13): a cell holding Python instead of a value or a formula.
 * Its value is its last run's result, an ordinary value the formulas read;
 * its source, outputs and run state live beside the cells, keyed by the
 * cell's row and column ids, so a code cell travels with its row and column
 * through inserts, deletes and moves (a deleted row's code cell is out of
 * sight until the delete is undone). Running it is `./jupyter`'s.
 *
 * @module core/code
 */

import type { CommandHandler } from '../points/index.js';
import { type CommandResult, OK, refuse } from './commands.js';
import type { Patch, PatchOp } from './patches.js';
import { snapshot, snapshotEntries, snapshotOf } from './patches.js';
import type { CellContent } from './cells.js';
import { type CellValue, isCellError, isErrorCode } from './values.js';
import type { Sheet, Workbook } from './workbook.js';
import { columnLetters, parseA1 } from './zone.js';

/** One output of a run, in nbformat's shape (`stream`, `display_data`, `execute_result`, `error`). */
export interface CodeOutput {
  readonly output_type: 'stream' | 'display_data' | 'execute_result' | 'error';
  readonly [field: string]: unknown;
}

/** A code cell's stored result: what its cell shows and the formulas read. */
export type CodeResult = number | string | boolean | null | { readonly error: string };

/** A code cell's content (§3.13): its source, its last run's outputs and result, how it runs, its output frame. */
export interface CodeCell {
  readonly source: string;
  /** The kernel's language; Python only, for now. */
  readonly language: 'python';
  /** The last run's outputs, nbformat's. */
  readonly outputs: readonly CodeOutput[];
  /** The last run's value: the cell's value. */
  readonly result: CodeResult;
  readonly executionCount?: number;
  /** When it last ran, ISO time. */
  readonly lastRun?: string;
  /** `auto`: run again when what it reads changes; `manual` (the default): marked stale. */
  readonly run: 'manual' | 'auto';
  /** The output frame: its size and its offset from its place beside the cell, px at zoom 1; `null`: no frame, the result alone. */
  readonly frame?: CodeFrame | null;
}

/**
 * A code cell's output frame: its size, and where it was dropped, as an
 * offset (`dx`, `dy`, px at zoom 1, either sign) from its place beside the
 * cell (its top-left at the cell's top-right corner). The offset moves with
 * its cell, as the frame does.
 */
export interface CodeFrame {
  readonly width: number;
  readonly height: number;
  readonly dx?: number;
  readonly dy?: number;
}

const FRAME_FIELDS = ['width', 'height', 'dx', 'dy'];

/** The style type a code cell carries (its cell type). */
export const CODE_CELL_TYPE = 'code';

const OUTPUT_TYPES = ['stream', 'display_data', 'execute_result', 'error'];
const FIELDS = [
  'source',
  'language',
  'outputs',
  'result',
  'executionCount',
  'lastRun',
  'run',
  'frame',
];

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** A code cell's first problem, with the path of the bad field; `undefined` when it is well formed. */
export function codeProblem(v: unknown, path = 'code'): string | undefined {
  if (!isObject(v)) return `${path}: a code cell is { source, language, outputs, result, run }`;
  for (const k of Object.keys(v))
    if (!FIELDS.includes(k)) return `${path}.${k}: a code cell has ${FIELDS.join(', ')} only`;
  if (typeof v.source !== 'string') return `${path}.source: the code, a string`;
  if (v.language !== 'python') return `${path}.language: 'python'`;
  if (!Array.isArray(v.outputs)) return `${path}.outputs: a list of nbformat outputs`;
  for (let i = 0; i < v.outputs.length; i += 1) {
    const o = v.outputs[i] as unknown;
    if (!isObject(o) || !OUTPUT_TYPES.includes(o.output_type as string))
      return `${path}.outputs[${i}].output_type: one of ${OUTPUT_TYPES.join(', ')}`;
  }
  const r = v.result;
  const value =
    r === null ||
    typeof r === 'string' ||
    typeof r === 'boolean' ||
    (typeof r === 'number' && Number.isFinite(r)) ||
    (isObject(r) &&
      Object.keys(r).length === 1 &&
      typeof r.error === 'string' &&
      isErrorCode(r.error));
  if (!value) return `${path}.result: a value (a number, a string, a boolean, null or { error })`;
  if (
    v.executionCount !== undefined &&
    !(Number.isInteger(v.executionCount) && (v.executionCount as number) >= 0)
  )
    return `${path}.executionCount: a non-negative integer`;
  if (
    v.lastRun !== undefined &&
    (typeof v.lastRun !== 'string' || Number.isNaN(Date.parse(v.lastRun)))
  )
    return `${path}.lastRun: an ISO time`;
  if (v.run !== 'manual' && v.run !== 'auto') return `${path}.run: 'manual' or 'auto'`;
  if (v.frame !== undefined && v.frame !== null) {
    const f = v.frame as unknown;
    if (!isObject(f)) return `${path}.frame: { width, height } or null`;
    for (const k of Object.keys(f))
      if (!FRAME_FIELDS.includes(k))
        return `${path}.frame.${k}: a frame has ${FRAME_FIELDS.join(', ')} only`;
    for (const k of ['width', 'height'])
      if (!(typeof f[k] === 'number' && (f[k] as number) > 0 && Number.isFinite(f[k])))
        return `${path}.frame.${k}: a positive size in px`;
    for (const k of ['dx', 'dy'])
      if (f[k] !== undefined && !(typeof f[k] === 'number' && Number.isFinite(f[k])))
        return `${path}.frame.${k}: an offset in px, a finite number`;
  }
  return undefined;
}

/** A new code cell's defaults: no output, no result, manual. */
export function codeCell(source: string, fields: Partial<Omit<CodeCell, 'source'>> = {}): CodeCell {
  return { source, language: 'python', outputs: [], result: null, run: 'manual', ...fields };
}

/** The value a result is in a cell. */
export function resultValue(result: CodeResult): CellValue {
  return isObject(result) ? ({ error: (result as { error: string }).error } as CellValue) : result;
}

/** A cell value as a stored result. */
export function toResult(value: CellValue): CodeResult {
  return isCellError(value) ? { error: value.error } : (value as CodeResult);
}

/** The output frame's default size, px: what a code cell with outputs gets when its `frame` is unset. */
export const DEFAULT_CODE_FRAME = { width: 360, height: 240 } as const;

/** The frame a code cell shows its outputs in: its own (with its offset), the default, or none (`frame: null`, or nothing to show). */
export function codeFrame(code: CodeCell): CodeFrame | undefined {
  if (code.frame === null || code.outputs.length === 0) return undefined;
  return code.frame ?? DEFAULT_CODE_FRAME;
}

// ------------------------------------------------------------------ where code cells live

/** The key of a position, by its row and column ids (materialised: the key follows the cell). */
export function codeKey(sheet: Sheet, row: number, col: number): string {
  return `${sheet.rows.materialize(row)}.${sheet.cols.materialize(col)}`;
}

/** The code cell at a position, if any. */
export function codeAt(sheet: Sheet, row: number, col: number): CodeCell | undefined {
  if (sheet.code.size === 0) return undefined;
  return sheet.code.get(`${sheet.rows.idAt(row)}.${sheet.cols.idAt(col)}`);
}

/** Where a key is now; `undefined` when its row or column is deleted. */
export function codePosition(sheet: Sheet, key: string): { row: number; col: number } | undefined {
  const [r, c] = key.split('.').map(Number);
  const row = sheet.rows.indexOfId(r);
  const col = sheet.cols.indexOfId(c);
  return row < 0 || col < 0 ? undefined : { row, col };
}

/** The code cells of a sheet in sight, with their positions, in reading order. */
export function codeCells(sheet: Sheet): { row: number; col: number; code: CodeCell }[] {
  const out: { row: number; col: number; code: CodeCell }[] = [];
  for (const [key, code] of sheet.code) {
    const at = codePosition(sheet, key);
    if (at !== undefined) out.push({ ...at, code });
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** A position as the file keys it: `B4`. */
export const codeRef = (row: number, col: number) => `${columnLetters(col)}${row + 1}`;

/** A file key back to a position. */
export function codeRefPosition(ref: string): { row: number; col: number } {
  return parseA1(ref);
}

// ------------------------------------------------------------------ the patch op

/** The `code` patch op's patch: a code cell before and after (`null` for none), by key. */
export interface CodePatch {
  readonly op: 'code';
  readonly sheet: string;
  readonly key: string;
  readonly before: CodeCell | null;
  readonly after: CodeCell | null;
}

/** Writes or removes a code cell; its inverse swaps before and after. */
export const codeOp: PatchOp<CodePatch> = {
  op: 'code',
  apply(wb: Workbook, p) {
    const s = wb.sheet(p.sheet);
    if (p.after === null) s.code.delete(p.key);
    else s.code.set(p.key, p.after);
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  bytes: (p) => 256 + JSON.stringify(p.after ?? p.before ?? {}).length * 2,
  example: (wb) => ({
    op: 'code',
    sheet: 's1',
    key: codeKey(wb.sheet('s1'), 1, 1),
    before: null,
    after: codeCell('1 + 1'),
  }),
};

// ------------------------------------------------------------------ the command

/** Make a cell a code cell, change it (a run writes its outputs and result this way), or make it a plain cell again (`null`). */
export interface SetCodeCommand {
  readonly type: 'SET_CODE';
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  readonly code: CodeCell | null;
}

function styleWithType(wb: Workbook, style: number, type: string | undefined): number {
  const { type: _drop, ...rest } = wb.styles.get(style);
  return wb.styles.intern(type === undefined ? rest : { ...rest, type });
}

/** The patches of `SET_CODE`: the code cell, and its cell (the result as its value, the `code` type on its style). */
export function setCodePatches(wb: Workbook, c: SetCodeCommand): Patch[] {
  const sheet = wb.sheet(c.sheet);
  const key = codeKey(sheet, c.row, c.col);
  const before = sheet.code.get(key) ?? null;
  const zone = { top: c.row, left: c.col, bottom: c.row, right: c.col };
  const was = snapshot(sheet, zone);
  const current = snapshotEntries(was)[0]?.[2];
  const style = styleWithType(
    wb,
    current?.style ?? 0,
    c.code === null ? undefined : CODE_CELL_TYPE,
  );
  const content: CellContent | null =
    c.code === null
      ? style === 0
        ? null
        : { value: null, style }
      : { value: resultValue(c.code.result), style };
  const cells = {
    op: 'cells',
    sheet: sheet.id,
    zone,
    before: was,
    after: snapshotOf(content === null ? [] : [[c.row, c.col, content]]),
  } as Patch;
  return [
    { op: 'code', sheet: sheet.id, key, before, after: c.code } as CodePatch as unknown as Patch,
    cells,
  ];
}

/** `SET_CODE`: refused for a malformed code cell, a position outside the sheet, or a merged-over cell. */
export const setCode: CommandHandler<SetCodeCommand> = {
  type: 'SET_CODE',
  allow({ workbook }, c): CommandResult {
    if (!workbook.hasSheet(c.sheet)) return refuse('UnknownSheet', `No sheet '${c.sheet}'.`);
    const sheet = workbook.sheet(c.sheet);
    if (
      !Number.isInteger(c.row) ||
      !Number.isInteger(c.col) ||
      c.row < 0 ||
      c.col < 0 ||
      c.row >= sheet.rows.count ||
      c.col >= sheet.cols.count
    )
      return refuse('OutOfBounds', `No cell at row ${c.row}, column ${c.col}.`);
    if (c.code !== null) {
      const problem = codeProblem(c.code);
      if (problem !== undefined) return refuse('InvalidArgument', problem);
    }
    const merge = sheet.mergeAt(c.row, c.col);
    if (merge !== undefined && (merge.top !== c.row || merge.left !== c.col))
      return refuse('MergeOverlap', 'A code cell cannot sit under a merge.');
    return OK;
  },
  apply: ({ workbook }, c) => setCodePatches(workbook, c),
};
