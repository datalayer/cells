/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Positions, zones and A1 notation. Rows and columns are 0-based in memory;
 * A1 is 1-based for rows and lettered for columns.
 *
 * @module core/zone
 */

/** A cell position: row and column, 0-based. */
export interface Position {
  readonly row: number;
  readonly col: number;
}

/** A rectangle of cells, inclusive on both ends, 0-based. */
export interface Zone {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** A position on a named sheet. */
export interface CellAddress extends Position {
  readonly sheet: string;
}

/** Column letters of a 0-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(col: number): string {
  if (!Number.isInteger(col) || col < 0) throw new Error(`No column at index ${col}.`);
  let name = '';
  let n = col + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** The 0-based index of column letters: A → 0, AA → 26. Case-insensitive. */
export function columnIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) throw new Error(`'${letters}' is not a column (A to XFD).`);
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** `B3` for {row: 2, col: 1}. */
export function toA1(p: Position): string {
  return `${columnLetters(p.col)}${p.row + 1}`;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/;

/** The position of `B3` (anchors ignored). Throws on anything else. */
export function parseA1(text: string): Position {
  const m = CELL.exec(text.trim());
  if (!m) throw new Error(`'${text}' is not a cell reference such as B3.`);
  return { row: Number(m[2]) - 1, col: columnIndex(m[1]) };
}

/** The zone of `A1:C4`, `B3` (one cell), in any corner order. */
export function parseZone(text: string): Zone {
  const parts = text.trim().split(':');
  if (parts.length > 2 || parts[0] === '')
    throw new Error(`'${text}' is not a range such as A1:C4.`);
  const a = parseA1(parts[0]);
  const b = parts.length === 2 ? parseA1(parts[1]) : a;
  return zoneOf(a, b);
}

/** `A1:C4`, or `B3` for a single cell. */
export function zoneToA1(z: Zone): string {
  const tl = toA1({ row: z.top, col: z.left });
  return z.top === z.bottom && z.left === z.right
    ? tl
    : `${tl}:${toA1({ row: z.bottom, col: z.right })}`;
}

/** The smallest zone holding both positions. */
export function zoneOf(a: Position, b: Position = a): Zone {
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

/** Whether a zone holds a position. */
export function zoneContains(z: Zone, p: Position): boolean {
  return p.row >= z.top && p.row <= z.bottom && p.col >= z.left && p.col <= z.right;
}

/** Whether two zones share a cell. */
export function zonesOverlap(a: Zone, b: Zone): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

/** How many cells a zone holds. */
export function zoneSize(z: Zone): { rows: number; cols: number } {
  return { rows: z.bottom - z.top + 1, cols: z.right - z.left + 1 };
}

/** A reference that may name a sheet: `Sheet2!B3`, `'My sheet'!A1:B2`. */
export function splitSheet(ref: string): { sheet?: string; ref: string } {
  const bang = ref.lastIndexOf('!');
  if (bang < 0) return { ref };
  let sheet = ref.slice(0, bang);
  if (sheet.startsWith("'")) {
    if (!sheet.endsWith("'") || sheet.length < 2)
      throw new Error(`'${ref}' has an unclosed sheet name.`);
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  if (sheet === '') throw new Error(`'${ref}' names an empty sheet.`);
  return { sheet, ref: ref.slice(bang + 1) };
}
