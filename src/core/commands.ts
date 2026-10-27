/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The core commands: a typed union, each with a handler that refuses with
 * reasons or produces patches. `CellsCorePlugin` contributes the handlers to
 * the `datalayer.cells.command` point, as any plugin contributes its own.
 *
 * @module core/commands
 */

import type { CellContent } from './cells.js';
import {
  type AxisName,
  type CellsPatch,
  EMPTY_SNAPSHOT,
  type Patch,
  snapshot,
  snapshotEntries,
  snapshotOf,
} from './patches.js';
import { checkStyle, type Style } from './styles.js';
import { type CellValue, isCellError } from './values.js';
import type { Sheet, Workbook } from './workbook.js';
import { type Position, type Zone, zonesOverlap } from './zone.js';
import type { CommandHandler } from '../points/index.js';
import { formulaPatches } from '../formula/structure.js';
import type { ContributionPoint } from '@datalayer/reactor';

/** Why a command was refused. */
export type RefusalReason =
  | 'ReadOnly'
  | 'UnknownCommand'
  | 'UnknownSheet'
  | 'OutOfBounds'
  | 'InvalidArgument'
  | 'MergeOverlap'
  | 'NoMerge'
  | 'NotEmptyAtEnd'
  | 'LastSheet'
  | 'DuplicateSheetName'
  | 'InvalidSheetName'
  | 'Gate';

export interface Refusal {
  readonly reason: RefusalReason | (string & {});
  /** A sentence a person can read. */
  readonly message: string;
}

export type CommandResult =
  { readonly ok: true } | { readonly ok: false; readonly refusals: readonly Refusal[] };

export const OK: CommandResult = { ok: true };

export function refuse(reason: Refusal['reason'], message: string): CommandResult {
  return { ok: false, refusals: [{ reason, message }] };
}

/** What a handler sees: the workbook, read-only by contract (writes go through patches), and the contributions of the platform's points. */
export interface CommandContext {
  readonly workbook: Workbook;
  /** What a cell shows, its formula evaluated. */
  readonly value: (sheet: string, row: number, col: number) => CellValue;
  /** What plugins contribute to a point, in order (clipboard handlers, fill rules). */
  readonly contributions: <T>(point: ContributionPoint<T>) => readonly T[];
}

// ------------------------------------------------------------------ inputs

/**
 * What a cell is set to. A plain value is a literal; `{ formula }` a formula
 * (without `=`); `style` replaces the style (`null`: the default; absent: kept).
 */
export type CellInput =
  | CellValue
  | { readonly value?: CellValue; readonly formula?: string; readonly style?: Style | null };

/**
 * What typing `text` into a cell means: a formula for `=…`, a number, a
 * boolean (`TRUE`, `FALSE`), else the text itself. A leading `'` forces text.
 */
export function parseInput(text: string): CellInput {
  if (text.startsWith("'")) return text.slice(1);
  if (text.startsWith('=') && text.length > 1) return { formula: text.slice(1) };
  const trimmed = text.trim();
  if (trimmed !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed))
    return Number(trimmed);
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  return text === '' ? null : text;
}

// ------------------------------------------------------------------ the core commands

export interface SetCellsCommand {
  readonly type: 'SET_CELLS';
  readonly sheet: string;
  /** The top-left cell; `cells` is a block of rows from there. */
  readonly at: Position;
  readonly cells: readonly (readonly CellInput[])[];
}
export interface SetStyleCommand {
  readonly type: 'SET_STYLE';
  readonly sheet: string;
  readonly zone: Zone;
  /** Merged into each cell's style; `null` resets to the default. */
  readonly style: Style | null;
}
export interface ClearCommand {
  readonly type: 'CLEAR';
  readonly sheet: string;
  readonly zone: Zone;
  readonly what?: 'all' | 'contents' | 'styles';
}
export interface InsertAxisCommand {
  readonly type: 'INSERT_AXIS';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly at: number;
  readonly n: number;
}
export interface DeleteAxisCommand {
  readonly type: 'DELETE_AXIS';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly at: number;
  readonly n: number;
}
export interface MoveAxisCommand {
  readonly type: 'MOVE_AXIS';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly at: number;
  readonly n: number;
  /** Before this index, in the coordinates before the move. */
  readonly to: number;
}
export interface ResizeAxisCommand {
  readonly type: 'RESIZE_AXIS';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly from: number;
  /** Inclusive. */
  readonly to: number;
  readonly size: number;
}
export interface HideAxisCommand {
  readonly type: 'HIDE_AXIS';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly from: number;
  readonly to: number;
  readonly hidden: boolean;
}
export interface MergeCommand {
  readonly type: 'MERGE';
  readonly sheet: string;
  readonly zone: Zone;
}
export interface UnmergeCommand {
  readonly type: 'UNMERGE';
  readonly sheet: string;
  readonly zone: Zone;
}
export interface AddSheetCommand {
  readonly type: 'ADD_SHEET';
  readonly name?: string;
  /** Tab position; the end by default. */
  readonly at?: number;
  /** The id to give it; fresh by default. */
  readonly id?: string;
}
export interface DeleteSheetCommand {
  readonly type: 'DELETE_SHEET';
  readonly sheet: string;
}
export interface RenameSheetCommand {
  readonly type: 'RENAME_SHEET';
  readonly sheet: string;
  readonly name: string;
}
export interface MoveSheetCommand {
  readonly type: 'MOVE_SHEET';
  readonly sheet: string;
  readonly to: number;
}
export interface FreezeCommand {
  readonly type: 'FREEZE';
  readonly sheet: string;
  readonly rows: number;
  readonly cols: number;
}

export type CoreCommand =
  | SetCellsCommand
  | SetStyleCommand
  | ClearCommand
  | InsertAxisCommand
  | DeleteAxisCommand
  | MoveAxisCommand
  | ResizeAxisCommand
  | HideAxisCommand
  | MergeCommand
  | UnmergeCommand
  | AddSheetCommand
  | DeleteSheetCommand
  | RenameSheetCommand
  | MoveSheetCommand
  | FreezeCommand;

/** Any command: a core one, or a plugin's. */
export type Command = CoreCommand | ({ readonly type: string } & Record<string, unknown>);

// ------------------------------------------------------------------ helpers

function sheetOrRefusal(wb: Workbook, id: string): Sheet | CommandResult {
  return wb.hasSheet(id) ? wb.sheet(id) : refuse('UnknownSheet', `No sheet '${id}'.`);
}

const isResult = (x: unknown): x is CommandResult =>
  typeof x === 'object' &&
  x !== null &&
  'ok' in x &&
  typeof (x as { ok: unknown }).ok === 'boolean';

function zoneInSheet(sheet: Sheet, z: Zone): CommandResult {
  const ints = [z.top, z.left, z.bottom, z.right].every(Number.isInteger);
  if (!ints || z.top < 0 || z.left < 0 || z.top > z.bottom || z.left > z.right) {
    return refuse('InvalidArgument', `The zone ${JSON.stringify(z)} is not a zone.`);
  }
  if (z.bottom >= sheet.rows.count || z.right >= sheet.cols.count) {
    return refuse(
      'OutOfBounds',
      `The zone reaches past the sheet's ${sheet.rows.count} rows or ${sheet.cols.count} columns.`,
    );
  }
  return OK;
}

function spanInAxis(sheet: Sheet, axis: AxisName, at: number, n: number): CommandResult {
  const count = axis === 'rows' ? sheet.rows.count : sheet.cols.count;
  if (!Number.isInteger(at) || !Number.isInteger(n) || n < 1 || at < 0) {
    return refuse('InvalidArgument', `${n} ${axis} at ${at} is not a span.`);
  }
  if (at + n > count)
    return refuse('OutOfBounds', `${n} ${axis} at ${at} reach past the sheet's ${count}.`);
  return OK;
}

function contentOf(wb: Workbook, input: CellInput, previous: CellContent | null): CellContent {
  if (input === null || typeof input !== 'object' || isCellError(input)) {
    return { value: input as CellValue, style: previous?.style ?? 0 };
  }
  const style =
    input.style === undefined
      ? (previous?.style ?? 0)
      : input.style === null
        ? 0
        : wb.styles.intern(input.style);
  if (input.formula !== undefined) {
    if (input.value !== undefined && input.value !== null) {
      // A cached value travels with a formula only through loading and paste.
      return { value: input.value, formula: input.formula, style };
    }
    return { value: null, formula: input.formula, style };
  }
  return { value: input.value ?? null, style };
}

function checkInput(input: CellInput): string | undefined {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return undefined;
  if (typeof input === 'number')
    return Number.isFinite(input) ? undefined : `${input} is not a cell value`;
  if (isCellError(input)) return undefined;
  if (typeof input !== 'object') return `${String(input)} is not a cell input`;
  if (input.formula !== undefined && (typeof input.formula !== 'string' || input.formula === '')) {
    return 'a formula is a non-empty string, without the =';
  }
  if (input.style !== undefined && input.style !== null) {
    try {
      checkStyle(input.style);
    } catch (error) {
      return (error as Error).message;
    }
  }
  const v = input.value;
  if (v !== undefined && v !== null && typeof v === 'number' && !Number.isFinite(v))
    return `${v} is not a cell value`;
  return undefined;
}

/** A cells patch writing `contents` (by position) over `zone`, from the current state. */
export function cellsPatch(
  sheet: Sheet,
  zone: Zone,
  contents: readonly [number, number, CellContent | null][],
): CellsPatch {
  const before = snapshot(sheet, zone);
  const after = new Map<string, [number, number, CellContent]>();
  for (const e of snapshotEntries(before)) after.set(`${e[0]},${e[1]}`, e);
  for (const [row, col, c] of contents) {
    const key = `${row},${col}`;
    if (c === null || (c.value === null && c.formula === undefined && c.style === 0))
      after.delete(key);
    else after.set(key, [row, col, c]);
  }
  return { op: 'cells', sheet: sheet.id, zone, before, after: snapshotOf([...after.values()]) };
}

function mergedStyle(wb: Workbook, current: number, style: Style | null): number {
  if (style === null) return 0;
  return wb.styles.intern({ ...wb.styles.get(current), ...style });
}

function sizesPatch(
  sheet: Sheet,
  axis: AxisName,
  at: number,
  n: number,
  change: (k: number, size: number, hidden: boolean) => [number, boolean],
): Patch {
  const a = axis === 'rows' ? sheet.rows : sheet.cols;
  const before = { sizes: new Float64Array(n), hidden: new Uint8Array(n) };
  const after = { sizes: new Float64Array(n), hidden: new Uint8Array(n) };
  for (let k = 0; k < n; k += 1) {
    const size = a.sizeOf(at + k);
    const hidden = a.isHidden(at + k);
    before.sizes[k] = size;
    before.hidden[k] = hidden ? 1 : 0;
    const [s, h] = change(k, size, hidden);
    after.sizes[k] = s;
    after.hidden[k] = h ? 1 : 0;
  }
  return { op: 'axis-sizes', sheet: sheet.id, axis, at, n, before, after } as Patch;
}

/** Merges after an axis edit: shifted, shrunk, or dropped when they vanish or become one cell. */
function mergesAfterAxis(
  merges: readonly Zone[],
  axis: AxisName,
  at: number,
  n: number,
  count: number,
): Zone[] {
  const out: Zone[] = [];
  for (const m of merges) {
    const lo = axis === 'rows' ? m.top : m.left;
    const hi = axis === 'rows' ? m.bottom : m.right;
    let nlo = lo;
    let nhi = hi;
    if (n > 0) {
      if (lo >= at) nlo += n;
      if (hi >= at) nhi += n;
      if (nhi >= count) continue;
    } else {
      const d = -n;
      const end = at + d;
      const shift = (i: number) => (i >= end ? i - d : i >= at ? at : i);
      nlo = shift(lo);
      nhi = hi >= end ? hi - d : hi >= at ? at - 1 : hi;
      if (nhi < nlo) continue;
    }
    const z = axis === 'rows' ? { ...m, top: nlo, bottom: nhi } : { ...m, left: nlo, right: nhi };
    if (z.top === z.bottom && z.left === z.right) continue;
    out.push(z);
  }
  return out;
}

const sameMerges = (a: readonly Zone[], b: readonly Zone[]) =>
  JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ handlers

const setCells: CommandHandler<SetCellsCommand> = {
  type: 'SET_CELLS',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    if (
      !Array.isArray(c.cells) ||
      c.cells.length === 0 ||
      !c.cells.every((r) => Array.isArray(r))
    ) {
      return refuse('InvalidArgument', 'SET_CELLS takes a non-empty block of rows.');
    }
    const width = Math.max(...c.cells.map((r) => r.length));
    if (width === 0) return refuse('InvalidArgument', 'SET_CELLS takes at least one cell.');
    for (const row of c.cells) {
      for (const input of row) {
        const wrong = checkInput(input);
        if (wrong) return refuse('InvalidArgument', `SET_CELLS: ${wrong}.`);
      }
    }
    return zoneInSheet(sheet, {
      top: c.at.row,
      left: c.at.col,
      bottom: c.at.row + c.cells.length - 1,
      right: c.at.col + width - 1,
    });
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const width = Math.max(...c.cells.map((r) => r.length));
    const zone = {
      top: c.at.row,
      left: c.at.col,
      bottom: c.at.row + c.cells.length - 1,
      right: c.at.col + width - 1,
    };
    const contents: [number, number, CellContent][] = [];
    c.cells.forEach((cells, dr) =>
      cells.forEach((input, dc) => {
        const row = c.at.row + dr;
        const col = c.at.col + dc;
        contents.push([row, col, contentOf(workbook, input, sheet.cells.get(row, col))]);
      }),
    );
    return [cellsPatch(sheet, zone, contents)];
  },
};

const setStyle: CommandHandler<SetStyleCommand> = {
  type: 'SET_STYLE',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    if (c.style !== null) {
      try {
        checkStyle(c.style);
      } catch (error) {
        return refuse('InvalidArgument', (error as Error).message);
      }
    }
    return zoneInSheet(sheet, c.zone);
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const contents: [number, number, CellContent][] = [];
    const { top, left, bottom, right } = c.zone;
    const cellCount = (bottom - top + 1) * (right - left + 1);
    if (cellCount > 1_000_000) {
      // Whole columns or rows: style the populated cells only (row and column styles come later).
      for (const [row, col, content] of sheet.cells.entries(c.zone)) {
        contents.push([
          row,
          col,
          { ...content, style: mergedStyle(workbook, content.style, c.style) },
        ]);
      }
    } else {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) {
          const content = sheet.cells.get(row, col) ?? { value: null, style: 0 };
          contents.push([
            row,
            col,
            { ...content, style: mergedStyle(workbook, content.style, c.style) },
          ]);
        }
      }
    }
    return [cellsPatch(sheet, c.zone, contents)];
  },
};

const clear: CommandHandler<ClearCommand> = {
  type: 'CLEAR',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    if (c.what !== undefined && !['all', 'contents', 'styles'].includes(c.what)) {
      return refuse('InvalidArgument', `CLEAR clears all, contents or styles, not '${c.what}'.`);
    }
    return zoneInSheet(sheet, c.zone);
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const what = c.what ?? 'all';
    const contents: [number, number, CellContent | null][] = [];
    for (const [row, col, content] of sheet.cells.entries(c.zone)) {
      if (what === 'all') contents.push([row, col, null]);
      else if (what === 'contents')
        contents.push([row, col, { value: null, style: content.style }]);
      else contents.push([row, col, { ...content, style: 0 }]);
    }
    return [cellsPatch(sheet, c.zone, contents)];
  },
};

const insertAxis: CommandHandler<InsertAxisCommand> = {
  type: 'INSERT_AXIS',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    if (c.axis !== 'rows' && c.axis !== 'cols')
      return refuse('InvalidArgument', `No axis '${String(c.axis)}'.`);
    const span = spanInAxis(sheet, c.axis, c.at, c.n);
    if (!span.ok) return span;
    const count = c.axis === 'rows' ? sheet.rows.count : sheet.cols.count;
    const tail: Zone =
      c.axis === 'rows'
        ? { top: count - c.n, left: 0, bottom: count - 1, right: sheet.cols.count - 1 }
        : { top: 0, left: count - c.n, bottom: sheet.rows.count - 1, right: count - 1 };
    if (!sheet.cells.isEmpty(tail) || sheet.mergesIn(tail).length > 0) {
      return refuse(
        'NotEmptyAtEnd',
        `Inserting ${c.n} ${c.axis} would push content off the end of the sheet.`,
      );
    }
    return OK;
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const axis = c.axis === 'rows' ? sheet.rows : sheet.cols;
    const count = axis.count;
    const tail = axis.segment(count - c.n, c.n);
    const patch = {
      op: 'axis-insert' as const,
      sheet: sheet.id,
      axis: c.axis,
      at: c.at,
      n: c.n,
      inserted: { ids: axis.freshIds(c.n), sizes: null, hidden: null },
      dropped: tail,
    };
    const merges = mergesAfterAxis(sheet.merges, c.axis, c.at, c.n, count);
    const out: Patch[] = [patch];
    if (!sameMerges(merges, sheet.merges))
      out.push({ op: 'merges', sheet: sheet.id, before: sheet.merges, after: merges } as Patch);
    out.push(...formulaPatches(workbook, sheet.id, c.axis, { kind: 'insert', at: c.at, n: c.n }));
    return out;
  },
};

const deleteAxis: CommandHandler<DeleteAxisCommand> = {
  type: 'DELETE_AXIS',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    if (c.axis !== 'rows' && c.axis !== 'cols')
      return refuse('InvalidArgument', `No axis '${String(c.axis)}'.`);
    return spanInAxis(sheet, c.axis, c.at, c.n);
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const axis = c.axis === 'rows' ? sheet.rows : sheet.cols;
    const zone: Zone =
      c.axis === 'rows'
        ? { top: c.at, left: 0, bottom: c.at + c.n - 1, right: sheet.cols.count - 1 }
        : { top: 0, left: c.at, bottom: sheet.rows.count - 1, right: c.at + c.n - 1 };
    const out: Patch[] = [];
    const before = snapshot(sheet, zone);
    if (before.rows.length > 0)
      out.push({ op: 'cells', sheet: sheet.id, zone, before, after: EMPTY_SNAPSHOT } as Patch);
    const merges = mergesAfterAxis(sheet.merges, c.axis, c.at, -c.n, axis.count);
    if (!sameMerges(merges, sheet.merges))
      out.push({ op: 'merges', sheet: sheet.id, before: sheet.merges, after: merges } as Patch);
    out.push({
      op: 'axis-delete',
      sheet: sheet.id,
      axis: c.axis,
      at: c.at,
      n: c.n,
      removed: axis.segment(c.at, c.n),
    } as Patch);
    out.push(...formulaPatches(workbook, sheet.id, c.axis, { kind: 'delete', at: c.at, n: c.n }));
    return out;
  },
};

const moveAxis: CommandHandler<MoveAxisCommand> = {
  type: 'MOVE_AXIS',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    const span = spanInAxis(sheet, c.axis, c.at, c.n);
    if (!span.ok) return span;
    const count = c.axis === 'rows' ? sheet.rows.count : sheet.cols.count;
    if (
      !Number.isInteger(c.to) ||
      c.to < 0 ||
      c.to > count ||
      (c.to >= c.at && c.to <= c.at + c.n)
    ) {
      return refuse('InvalidArgument', `Cannot move ${c.n} ${c.axis} at ${c.at} to ${c.to}.`);
    }
    const lo = Math.min(c.at, c.to);
    const hi = Math.max(c.at + c.n, c.to) - 1;
    const zone: Zone =
      c.axis === 'rows'
        ? { top: lo, left: 0, bottom: hi, right: sheet.cols.count - 1 }
        : { top: 0, left: lo, bottom: sheet.rows.count - 1, right: hi };
    if (sheet.mergesIn(zone).length > 0)
      return refuse(
        'MergeOverlap',
        'Moving across merged cells is not supported yet; unmerge first.',
      );
    return OK;
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const lo = Math.min(c.at, c.to);
    const hi = Math.max(c.at + c.n, c.to) - 1;
    const zone: Zone =
      c.axis === 'rows'
        ? { top: lo, left: 0, bottom: hi, right: sheet.cols.count - 1 }
        : { top: 0, left: lo, bottom: sheet.rows.count - 1, right: hi };
    const map = (i: number) => {
      if (i >= c.at && i < c.at + c.n)
        return c.to < c.at ? c.to + (i - c.at) : c.to - c.n + (i - c.at);
      if (c.to < c.at && i >= c.to && i < c.at) return i + c.n;
      if (c.to > c.at && i >= c.at + c.n && i < c.to) return i - c.n;
      return i;
    };
    const before = snapshot(sheet, zone);
    const moved = snapshotEntries(before).map(([row, col, content]) =>
      c.axis === 'rows' ? ([map(row), col, content] as const) : ([row, map(col), content] as const),
    );
    return [
      { op: 'cells', sheet: sheet.id, zone, before, after: snapshotOf(moved) } as Patch,
      { op: 'axis-move', sheet: sheet.id, axis: c.axis, at: c.at, n: c.n, to: c.to } as Patch,
      ...formulaPatches(workbook, sheet.id, c.axis, {
        kind: 'move',
        at: c.at,
        n: c.n,
        to: c.to,
      }),
    ];
  },
};

const resizeAxis: CommandHandler<ResizeAxisCommand> = {
  type: 'RESIZE_AXIS',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    if (!(c.size > 0) || !Number.isFinite(c.size))
      return refuse('InvalidArgument', `A size must be positive; ${c.size} was given.`);
    return spanInAxis(sheet, c.axis, c.from, c.to - c.from + 1);
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    return [
      sizesPatch(sheet, c.axis, c.from, c.to - c.from + 1, (_k, _s, hidden) => [c.size, hidden]),
    ];
  },
};

const hideAxis: CommandHandler<HideAxisCommand> = {
  type: 'HIDE_AXIS',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    return spanInAxis(sheet, c.axis, c.from, c.to - c.from + 1);
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    return [sizesPatch(sheet, c.axis, c.from, c.to - c.from + 1, (_k, size) => [size, c.hidden])];
  },
};

const merge: CommandHandler<MergeCommand> = {
  type: 'MERGE',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    const inSheet = zoneInSheet(sheet, c.zone);
    if (!inSheet.ok) return inSheet;
    if (c.zone.top === c.zone.bottom && c.zone.left === c.zone.right) {
      return refuse('InvalidArgument', 'A merge spans more than one cell.');
    }
    const overlapping = sheet.mergesIn(c.zone);
    if (overlapping.length > 0)
      return refuse('MergeOverlap', 'The zone overlaps a merge; unmerge it first.');
    return OK;
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    // As Excel: the top-left cell's content stays, the others are cleared.
    const contents: [number, number, CellContent | null][] = [];
    for (const [row, col] of sheet.cells.entries(c.zone)) {
      if (row !== c.zone.top || col !== c.zone.left) contents.push([row, col, null]);
    }
    const out: Patch[] = [];
    if (contents.length > 0) out.push(cellsPatch(sheet, c.zone, contents));
    out.push({
      op: 'merges',
      sheet: sheet.id,
      before: sheet.merges,
      after: [...sheet.merges, c.zone],
    } as Patch);
    return out;
  },
};

const unmerge: CommandHandler<UnmergeCommand> = {
  type: 'UNMERGE',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    const inSheet = zoneInSheet(sheet, c.zone);
    if (!inSheet.ok) return inSheet;
    return sheet.mergesIn(c.zone).length === 0 ? refuse('NoMerge', 'Nothing is merged there.') : OK;
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const after = sheet.merges.filter((m) => !zonesOverlap(m, c.zone));
    return [{ op: 'merges', sheet: sheet.id, before: sheet.merges, after } as Patch];
  },
};

function checkName(wb: Workbook, name: unknown, except?: string): CommandResult {
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name.length > 31 ||
    /[\\/?*[\]:]/.test(name) ||
    /^'|'$/.test(name)
  ) {
    return refuse(
      'InvalidSheetName',
      `'${String(name)}' is not a sheet name: 1 to 31 characters, none of \\ / ? * [ ] :, no leading or trailing '.`,
    );
  }
  const other = wb.sheetByName(name);
  if (other !== undefined && other.id !== except)
    return refuse('DuplicateSheetName', `A sheet is called '${name}' already.`);
  return OK;
}

const addSheet: CommandHandler<AddSheetCommand> = {
  type: 'ADD_SHEET',
  allow({ workbook }, c) {
    if (
      c.at !== undefined &&
      (!Number.isInteger(c.at) || c.at < 0 || c.at > workbook.sheets.length)
    ) {
      return refuse('OutOfBounds', `No tab position ${c.at}.`);
    }
    if (c.id !== undefined && workbook.hasSheet(c.id))
      return refuse('InvalidArgument', `A sheet has the id '${c.id}' already.`);
    return c.name === undefined ? OK : checkName(workbook, c.name);
  },
  apply({ workbook }, c) {
    const sheet = workbook.createSheet(c.name ?? workbook.freshSheetName(), c.id);
    return [{ op: 'sheet-add', index: c.at ?? workbook.sheets.length, sheet } as Patch];
  },
};

const deleteSheet: CommandHandler<DeleteSheetCommand> = {
  type: 'DELETE_SHEET',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    return workbook.sheets.length === 1
      ? refuse('LastSheet', 'A workbook keeps at least one sheet.')
      : OK;
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    return [{ op: 'sheet-delete', index: workbook.sheets.indexOf(sheet), sheet } as Patch];
  },
};

const renameSheet: CommandHandler<RenameSheetCommand> = {
  type: 'RENAME_SHEET',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    return checkName(workbook, c.name, c.sheet);
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    return [{ op: 'sheet-rename', sheet: sheet.id, before: sheet.name, after: c.name } as Patch];
  },
};

const moveSheet: CommandHandler<MoveSheetCommand> = {
  type: 'MOVE_SHEET',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    if (!Number.isInteger(c.to) || c.to < 0 || c.to >= workbook.sheets.length)
      return refuse('OutOfBounds', `No tab position ${c.to}.`);
    return OK;
  },
  apply({ workbook }, c) {
    const from = workbook.sheets.indexOf(workbook.sheet(c.sheet));
    return from === c.to ? [] : [{ op: 'sheet-move', from, to: c.to } as Patch];
  },
};

const freeze: CommandHandler<FreezeCommand> = {
  type: 'FREEZE',
  allow({ workbook }, c) {
    const sheet = sheetOrRefusal(workbook, c.sheet);
    if (isResult(sheet)) return sheet;
    const ok = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n < max;
    if (!ok(c.rows, sheet.rows.count) || !ok(c.cols, sheet.cols.count)) {
      return refuse('OutOfBounds', `Cannot freeze ${c.rows} rows and ${c.cols} columns.`);
    }
    const frozenZone = (m: Zone) =>
      (c.rows > 0 && m.top < c.rows && m.bottom >= c.rows) ||
      (c.cols > 0 && m.left < c.cols && m.right >= c.cols);
    if (sheet.merges.some(frozenZone))
      return refuse('MergeOverlap', 'A merge crosses the frozen edge.');
    return OK;
  },
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    return [
      {
        op: 'frozen',
        sheet: sheet.id,
        before: sheet.frozen,
        after: { rows: c.rows, cols: c.cols },
      } as Patch,
    ];
  },
};

/** The core command handlers, contributed by `CellsCorePlugin`. */
export const CORE_COMMANDS: readonly CommandHandler<any>[] = [
  setCells,
  setStyle,
  clear,
  insertAxis,
  deleteAxis,
  moveAxis,
  resizeAxis,
  hideAxis,
  merge,
  unmerge,
  addSheet,
  deleteSheet,
  renameSheet,
  moveSheet,
  freeze,
];
