/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Copy and paste in the model. A copy is a slice: what each clipboard handler
 * (the `datalayer.cells.clipboard` point, one per feature: cells, merges,
 * sizes, and a plugin's own) takes from a zone. A paste hands the slice to the
 * same handlers, which return patches; the `PASTE` command applies them as
 * one undo step, or refuses (a paste past the sheet's end, across a merge).
 *
 * Text interchange (TSV) lives here too; HTML lives in the React layer, which
 * has a DOM to parse it.
 *
 * @module core/clipboard
 */

import type { CellsPatch, Patch } from './patches.js';
import type { CellContent } from './cells.js';
import {
  cellsPatch,
  type CommandContext,
  type CommandResult,
  OK,
  parseInput,
  refuse,
} from './commands.js';
import type { Style } from './styles.js';
import { type CellValue, isCellError } from './values.js';
import type { Workbook } from './workbook.js';
import { type Zone, zonesOverlap } from './zone.js';
import { translateFormula, transposeFormula } from '../formula/normal.js';

/** The version of the clipboard slice format; a slice of another version is refused. */
export const SLICE_VERSION = 1;

/** What a copy holds: the source and each handler's part. */
export interface Slice {
  readonly version: 1;
  /** The zone copied, for its size, and whether it was cut (the paste then clears it). */
  readonly rows: number;
  readonly cols: number;
  readonly source?: { readonly sheet: string; readonly zone: Zone; readonly cut: boolean };
  readonly parts: Readonly<Record<string, unknown>>;
}

/** How to paste: everything, or only values, only formats, only formulas; and transposed. */
export interface PasteOptions {
  readonly special?: 'all' | 'values' | 'formats' | 'formulas';
  readonly transpose?: boolean;
}

/** A cell as the cells handler carries it: its value or formula, and its style by content. */
export interface SliceCell {
  readonly r: number;
  readonly c: number;
  readonly v?: CellValue;
  readonly f?: string;
  readonly style?: Style;
}

/** Paste a clipboard slice at a cell, with paste-special options. */
export interface PasteCommand {
  readonly type: 'PASTE';
  readonly sheet: string;
  /** The top-left cell of the target. */
  readonly at: { readonly row: number; readonly col: number };
  readonly slice: Slice;
  readonly options?: PasteOptions;
}

/** The size a slice takes once pasted, transposed or not. */
export function pastedSize(
  slice: Slice,
  options: PasteOptions = {},
): { rows: number; cols: number } {
  return options.transpose
    ? { rows: slice.cols, cols: slice.rows }
    : { rows: slice.rows, cols: slice.cols };
}

/** Throws a sentence naming the first thing wrong with a slice (it may come from another application's clipboard). */
export function checkSlice(slice: unknown): asserts slice is Slice {
  const s = slice as Partial<Slice>;
  if (typeof slice !== 'object' || slice === null)
    throw new Error('A clipboard slice is an object.');
  if (s.version !== SLICE_VERSION)
    throw new Error(
      `This clipboard slice is version ${String(s.version)}; Cells reads version ${SLICE_VERSION}.`,
    );
  if (
    !Number.isInteger(s.rows) ||
    !Number.isInteger(s.cols) ||
    (s.rows as number) < 1 ||
    (s.cols as number) < 1
  ) {
    throw new Error('A clipboard slice has a size of at least one cell.');
  }
  if (typeof s.parts !== 'object' || s.parts === null)
    throw new Error('A clipboard slice has parts.');
}

/** The cells handler's part: every populated cell of the zone, relative to its top-left. */
export function copyCells(context: CommandContext, sheet: string, zone: Zone): SliceCell[] {
  const { workbook } = context;
  const s = workbook.sheet(sheet);
  const out: SliceCell[] = [];
  for (const [row, col, c] of s.cells.entries(zone)) {
    const style = c.style === 0 ? undefined : workbook.styles.get(c.style);
    // A formula travels with the value it shows, for a paste of values.
    const v = c.formula === undefined ? c.value : context.value(sheet, row, col);
    out.push({
      r: row - zone.top,
      c: col - zone.left,
      ...(v !== null ? { v } : {}),
      ...(c.formula !== undefined ? { f: c.formula } : {}),
      ...(style ? { style } : {}),
    });
  }
  return out;
}

/** The cells handler's paste: the patch writing a slice's cells over the target zone. */
export function pasteCells(
  context: CommandContext,
  sheet: string,
  cells: readonly SliceCell[],
  target: Zone,
  options: PasteOptions,
  source?: Slice['source'],
): CellsPatch {
  const wb = context.workbook;
  const s = wb.sheet(sheet);
  const limits = { rows: s.rows.count, cols: s.cols.count };
  const special = options.special ?? 'all';
  const contents: [number, number, CellContent | null][] = [];
  const written = new Set<string>();
  for (const cell of cells) {
    const [dr, dc] = options.transpose ? [cell.c, cell.r] : [cell.r, cell.c];
    const row = target.top + dr;
    const col = target.left + dc;
    const previous = s.cells.get(row, col);
    written.add(`${row},${col}`);
    const style =
      special === 'values' || special === 'formulas'
        ? (previous?.style ?? 0)
        : cell.style
          ? wb.styles.intern(cell.style)
          : 0;
    if (special === 'formats') {
      contents.push([
        row,
        col,
        previous === null ? { value: null, style } : { ...previous, style },
      ]);
    } else if (special === 'values' || cell.f === undefined) {
      contents.push([row, col, { value: cell.v ?? null, style }]);
    } else {
      // A copied formula's relative references move with it; a cut one keeps them, as in Excel.
      const origin = source && { row: source.zone.top + cell.r, col: source.zone.left + cell.c };
      const formula =
        source === undefined || source.cut
          ? cell.f
          : options.transpose
            ? transposeFormula(cell.f, origin!, { row, col }, limits)
            : translateFormula(cell.f, row - origin!.row, col - origin!.col, limits);
      contents.push([row, col, { value: null, formula, style }]);
    }
  }
  // The target's other cells are emptied (all) or keep what they had (values, formats, formulas keep styles or values).
  for (const [row, col, prev] of s.cells.entries(target)) {
    if (written.has(`${row},${col}`)) continue;
    if (special === 'all') contents.push([row, col, null]);
    else if (special === 'values' || special === 'formulas')
      contents.push([row, col, { value: null, style: prev.style }]);
    else contents.push([row, col, { ...prev, style: 0 }]);
  }
  return cellsPatch(s, target, contents);
}

export function zoneOfPaste(
  at: { row: number; col: number },
  size: { rows: number; cols: number },
): Zone {
  return {
    top: at.row,
    left: at.col,
    bottom: at.row + size.rows - 1,
    right: at.col + size.cols - 1,
  };
}

/** The checks every paste passes before its handlers run. */
export function allowPaste(context: CommandContext, c: PasteCommand): CommandResult {
  if (!context.workbook.hasSheet(c.sheet)) return refuse('UnknownSheet', `No sheet '${c.sheet}'.`);
  try {
    checkSlice(c.slice);
  } catch (error) {
    return refuse('InvalidArgument', (error as Error).message);
  }
  const s = context.workbook.sheet(c.sheet);
  const target = zoneOfPaste(c.at, pastedSize(c.slice, c.options));
  if (
    target.top < 0 ||
    target.left < 0 ||
    target.bottom >= s.rows.count ||
    target.right >= s.cols.count
  ) {
    return refuse(
      'OutOfBounds',
      `The paste of ${target.bottom - target.top + 1} × ${target.right - target.left + 1} cells reaches past the end of the sheet.`,
    );
  }
  // A merge only partly inside the target would be cut in two.
  for (const m of s.mergesIn(target)) {
    const inside =
      m.top >= target.top &&
      m.bottom <= target.bottom &&
      m.left >= target.left &&
      m.right <= target.right;
    if (!inside)
      return refuse('MergeOverlap', 'The paste would cut a merged cell in two; unmerge it first.');
  }
  return OK;
}

// ------------------------------------------------------------------ TSV

/** A zone's shown values as tab-separated text, quoted where a value holds a tab, a newline or a quote. */
export function toTSV(rows: readonly (readonly string[])[]): string {
  const quote = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(quote).join('\t')).join('\n');
}

/** Tab-separated text as rows of strings, with quoted fields (as Excel writes them). */
export function parseTSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === '\t') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** A slice from rows of text typed or copied elsewhere: each field read as typing it would be. */
export function sliceFromText(
  rows: readonly (readonly string[])[],
  styles?: readonly (readonly (Style | undefined)[])[],
): Slice {
  const cells: SliceCell[] = [];
  let cols = 1;
  rows.forEach((row, r) => {
    cols = Math.max(cols, row.length);
    row.forEach((text, c) => {
      const input = parseInput(text);
      const style = styles?.[r]?.[c];
      if (input === null && style === undefined) return;
      if (
        input !== null &&
        typeof input === 'object' &&
        !isCellError(input) &&
        'formula' in input
      ) {
        cells.push({ r, c, f: input.formula, ...(style ? { style } : {}) });
      } else {
        cells.push({
          r,
          c,
          ...(input !== null ? { v: input as CellValue } : {}),
          ...(style ? { style } : {}),
        });
      }
    });
  });
  return { version: SLICE_VERSION, rows: Math.max(1, rows.length), cols, parts: { cells } };
}

export type { Patch };
export { zonesOverlap };
