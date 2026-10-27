/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The cells of a sheet, stored by column in chunks of 1,024 rows, each chunk
 * columnar: a kind byte, a number, a reference (into the string pool or the
 * formula table) and a style index per row. No object per cell: a numeric
 * cell costs 15 bytes in a full chunk.
 *
 * Positions are the in-memory address. Ids (the axes) are what collaboration
 * syncs; this store never sees them.
 *
 * @module core/cells
 */

import type { StringPool } from './strings.js';
import { type CellValue, cellError, isCellError, isErrorCode } from './values.js';
import type { Zone } from './zone.js';

export const CHUNK = 1024;
const SHIFT = 10;
const MASK = CHUNK - 1;

const enum Kind {
  Empty = 0,
  Number = 1,
  String = 2,
  Boolean = 3,
  Error = 4,
  Formula = 5,
}

/** What a cell holds, as persisted: a literal value, or a formula with its cached value; and a style. */
export interface CellContent {
  /** The literal value, or a formula's cached value (`null` when not yet computed). */
  readonly value: CellValue;
  /** The formula as typed, without the `=`. */
  readonly formula?: string;
  /** An index into the workbook's style table; 0 is the default. */
  readonly style: number;
}

/**
 * A formula's entry: its source, its computed value (`null` until the engine
 * computes it, and again when what it reads changes), and what the engine
 * keeps of it once parsed (its compiled shape and constants).
 */
export class FormulaEntry {
  constructor(
    readonly source: string,
    public cached: CellValue,
    public parsed: unknown = undefined,
  ) {}
}

/** The formula table: one entry per formula cell, reused through a free list. */
export class FormulaTable {
  #entries: (FormulaEntry | undefined)[] = [];
  #free: number[] = [];

  add(entry: FormulaEntry): number {
    const i = this.#free.pop() ?? this.#entries.length;
    this.#entries[i] = entry;
    return i;
  }

  get(i: number): FormulaEntry {
    const e = this.#entries[i];
    if (e === undefined) throw new Error(`No formula at ${i} in the formula table.`);
    return e;
  }

  remove(i: number): void {
    this.get(i);
    this.#entries[i] = undefined;
    this.#free.push(i);
  }

  get size(): number {
    return this.#entries.length - this.#free.length;
  }

  /** Every entry, in table order. */
  forEach(fn: (entry: FormulaEntry) => void): void {
    for (const e of this.#entries) if (e !== undefined) fn(e);
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = new Array(to - from + 1);
  for (let i = from; i <= to; i += 1) out[i - from] = i;
  return out;
}

class Chunk {
  readonly kind = new Uint8Array(CHUNK);
  readonly num = new Float64Array(CHUNK);
  readonly ref = new Uint32Array(CHUNK);
  readonly style = new Uint16Array(CHUNK);
  /** Rows holding a value or a style: the chunk is dropped at 0. */
  filled = 0;
}

class Column {
  readonly chunks = new Map<number, Chunk>();
}

export interface Pools {
  readonly strings: StringPool;
  readonly formulas: FormulaTable;
}

export class SheetCells {
  readonly #pools: Pools;
  #columns = new Map<number, Column>();
  #filled = 0;

  constructor(pools: Pools) {
    this.#pools = pools;
  }

  /** How many cells hold a value or a style. */
  get filled(): number {
    return this.#filled;
  }

  /** How many chunks are allocated, for `stats()`. */
  get chunkCount(): number {
    let n = 0;
    for (const c of this.#columns.values()) n += c.chunks.size;
    return n;
  }

  /** The columns holding anything, in no order. */
  columnIndexes(): IterableIterator<number> {
    return this.#columns.keys();
  }

  /** The content of a cell, or `null` when it holds neither a value nor a style. */
  get(row: number, col: number): CellContent | null {
    const chunk = this.#columns.get(col)?.chunks.get(row >>> SHIFT);
    if (chunk === undefined) return null;
    const i = row & MASK;
    if (chunk.kind[i] === Kind.Empty && chunk.style[i] === 0) return null;
    return this.#read(chunk, i);
  }

  /** The style index of a cell (0 when it has none). */
  styleAt(row: number, col: number): number {
    const chunk = this.#columns.get(col)?.chunks.get(row >>> SHIFT);
    return chunk === undefined ? 0 : chunk.style[row & MASK];
  }

  /** The formula entry of a cell holding a formula, else `undefined`. The evaluator's path. */
  formulaAt(row: number, col: number): FormulaEntry | undefined {
    const chunk = this.#columns.get(col)?.chunks.get(row >>> SHIFT);
    if (chunk === undefined) return undefined;
    const i = row & MASK;
    return chunk.kind[i] === Kind.Formula ? this.#pools.formulas.get(chunk.ref[i]) : undefined;
  }

  /** The number in a cell when it holds a literal number, else `undefined`. The aggregate path. */
  numberAt(row: number, col: number): number | undefined {
    const chunk = this.#columns.get(col)?.chunks.get(row >>> SHIFT);
    if (chunk === undefined) return undefined;
    const i = row & MASK;
    return chunk.kind[i] === Kind.Number ? chunk.num[i] : undefined;
  }

  /** Write a cell; `null` empties it (value and style). */
  set(row: number, col: number, content: CellContent | null): void {
    let column = this.#columns.get(col);
    const ci = row >>> SHIFT;
    let chunk = column?.chunks.get(ci);
    const i = row & MASK;
    if (chunk !== undefined) this.#clear(chunk, i);
    if (
      content === null ||
      (content.value === null && content.formula === undefined && content.style === 0)
    ) {
      if (chunk !== undefined && chunk.filled === 0) {
        column!.chunks.delete(ci);
        if (column!.chunks.size === 0) this.#columns.delete(col);
      }
      return;
    }
    if (column === undefined) {
      column = new Column();
      this.#columns.set(col, column);
    }
    if (chunk === undefined) {
      chunk = new Chunk();
      column.chunks.set(ci, chunk);
    }
    this.#write(chunk, i, content);
  }

  /** Every populated cell of a zone, column by column, rows ascending. */
  *entries(zone?: Zone): IterableIterator<[row: number, col: number, content: CellContent]> {
    // A narrow zone walks its own columns and chunks; a wide one, the ones there are, sorted.
    const cols =
      zone !== undefined && zone.right - zone.left < this.#columns.size
        ? range(zone.left, zone.right)
        : [...this.#columns.keys()].sort((a, b) => a - b);
    for (const col of cols) {
      if (zone && (col < zone.left || col > zone.right)) continue;
      const column = this.#columns.get(col);
      if (column === undefined) continue;
      const first = zone === undefined ? 0 : zone.top >>> SHIFT;
      const last = zone === undefined ? Infinity : zone.bottom >>> SHIFT;
      const chunkIds =
        last - first < column.chunks.size
          ? range(first, last)
          : [...column.chunks.keys()].sort((a, b) => a - b);
      for (const ci of chunkIds) {
        const base = ci << SHIFT;
        if (zone && (base + CHUNK - 1 < zone.top || base > zone.bottom)) continue;
        const chunk = column.chunks.get(ci);
        if (chunk === undefined) continue;
        const from = zone ? Math.max(0, zone.top - base) : 0;
        const to = zone ? Math.min(CHUNK - 1, zone.bottom - base) : CHUNK - 1;
        for (let i = from; i <= to; i += 1) {
          if (chunk.kind[i] === Kind.Empty && chunk.style[i] === 0) continue;
          yield [base + i, col, this.#read(chunk, i)];
        }
      }
    }
  }

  /**
   * Visit the values of a zone, column by column, rows ascending, without a
   * tuple or a content object per cell: the aggregate path. Formula cells are
   * visited with `formula: true` and no value (the evaluator reads them);
   * empty cells, and cells holding only a style, are skipped.
   */
  scan(
    zone: Zone,
    visit: (row: number, col: number, value: CellValue, formula: boolean) => void,
  ): void {
    const cols =
      zone.right - zone.left < this.#columns.size
        ? range(zone.left, zone.right)
        : [...this.#columns.keys()].sort((a, b) => a - b);
    const strings = this.#pools.strings;
    for (const col of cols) {
      if (col < zone.left || col > zone.right) continue;
      const column = this.#columns.get(col);
      if (column === undefined) continue;
      const first = zone.top >>> SHIFT;
      const last = zone.bottom >>> SHIFT;
      const chunkIds =
        last - first < column.chunks.size
          ? range(first, last)
          : [...column.chunks.keys()].sort((a, b) => a - b);
      for (const ci of chunkIds) {
        const base = ci << SHIFT;
        if (base + CHUNK - 1 < zone.top || base > zone.bottom) continue;
        const chunk = column.chunks.get(ci);
        if (chunk === undefined) continue;
        const from = Math.max(0, zone.top - base);
        const to = Math.min(CHUNK - 1, zone.bottom - base);
        const { kind, num, ref } = chunk;
        for (let i = from; i <= to; i += 1) {
          switch (kind[i] as Kind) {
            case Kind.Empty:
              break;
            case Kind.Number:
              visit(base + i, col, num[i], false);
              break;
            case Kind.Boolean:
              visit(base + i, col, num[i] !== 0, false);
              break;
            case Kind.String:
              visit(base + i, col, strings.get(ref[i]), false);
              break;
            case Kind.Error: {
              const code = strings.get(ref[i]);
              if (!isErrorCode(code)) throw new Error(`The store holds '${code}' as an error.`);
              visit(base + i, col, cellError(code), false);
              break;
            }
            case Kind.Formula:
              visit(base + i, col, null, true);
              break;
          }
        }
      }
    }
  }

  /** The last row holding anything in a column, or -1. */
  lastRowIn(col: number): number {
    const column = this.#columns.get(col);
    if (column === undefined) return -1;
    const ci = Math.max(...column.chunks.keys());
    const chunk = column.chunks.get(ci)!;
    for (let i = CHUNK - 1; i >= 0; i -= 1) {
      if (chunk.kind[i] !== Kind.Empty || chunk.style[i] !== 0) return (ci << SHIFT) + i;
    }
    throw new Error('A kept chunk holds nothing: the store is inconsistent.');
  }

  /** Whether a zone holds anything. */
  isEmpty(zone: Zone): boolean {
    for (const _ of this.entries(zone)) return false;
    return true;
  }

  /**
   * Move rows: `n > 0` inserts `n` empty rows at `at` (rows at the end fall off
   * `limit`); `n < 0` deletes `-n` rows from `at`. Only columns holding data are touched.
   */
  shiftRows(at: number, n: number, limit: number): void {
    for (const [col, column] of [...this.#columns]) {
      const moved: [number, CellContent][] = [];
      for (const [ci, chunk] of [...column.chunks]) {
        const base = ci << SHIFT;
        if (base + CHUNK - 1 < at) continue;
        for (let i = 0; i < CHUNK; i += 1) {
          const row = base + i;
          if (row < at) continue;
          if (chunk.kind[i] === Kind.Empty && chunk.style[i] === 0) continue;
          const content = this.#read(chunk, i);
          this.set(row, col, null);
          if (n < 0 && row < at - n) continue; // deleted
          const target = row + n;
          if (target < limit) moved.push([target, content]);
        }
      }
      for (const [row, content] of moved) this.set(row, col, content);
    }
  }

  /** Move columns: `n > 0` inserts at `at`, `n < 0` deletes `-n` from `at`. */
  shiftCols(at: number, n: number, limit: number): void {
    const keys = [...this.#columns.keys()]
      .filter((c) => c >= at)
      .sort((a, b) => (n > 0 ? b - a : a - b));
    for (const col of keys) {
      const column = this.#columns.get(col)!;
      this.#columns.delete(col);
      if (n < 0 && col < at - n) {
        for (const [ci, chunk] of column.chunks) {
          for (let i = 0; i < CHUNK; i += 1) this.#clear(chunk, i);
          void ci;
        }
        continue;
      }
      const target = col + n;
      if (target < limit) this.#columns.set(target, column);
      else
        for (const chunk of column.chunks.values())
          for (let i = 0; i < CHUNK; i += 1) this.#clear(chunk, i);
    }
  }

  #read(chunk: Chunk, i: number): CellContent {
    const style = chunk.style[i];
    switch (chunk.kind[i] as Kind) {
      case Kind.Empty:
        return { value: null, style };
      case Kind.Number:
        return { value: chunk.num[i], style };
      case Kind.Boolean:
        return { value: chunk.num[i] !== 0, style };
      case Kind.String:
        return { value: this.#pools.strings.get(chunk.ref[i]), style };
      case Kind.Error: {
        const code = this.#pools.strings.get(chunk.ref[i]);
        if (!isErrorCode(code)) throw new Error(`The store holds '${code}' as an error.`);
        return { value: cellError(code), style };
      }
      case Kind.Formula: {
        const e = this.#pools.formulas.get(chunk.ref[i]);
        return { value: e.cached, formula: e.source, style };
      }
    }
  }

  #write(chunk: Chunk, i: number, content: CellContent): void {
    const { value, formula, style } = content;
    if (!Number.isInteger(style) || style < 0 || style > 0xffff)
      throw new Error(`No style index ${style}.`);
    chunk.style[i] = style;
    if (formula !== undefined) {
      chunk.kind[i] = Kind.Formula;
      chunk.ref[i] = this.#pools.formulas.add(new FormulaEntry(formula, value));
    } else if (value === null) {
      chunk.kind[i] = Kind.Empty;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value))
        throw new Error(`A cell cannot hold ${value}; use an error value.`);
      chunk.kind[i] = Kind.Number;
      chunk.num[i] = value;
    } else if (typeof value === 'boolean') {
      chunk.kind[i] = Kind.Boolean;
      chunk.num[i] = value ? 1 : 0;
    } else if (typeof value === 'string') {
      chunk.kind[i] = Kind.String;
      chunk.ref[i] = this.#pools.strings.intern(value);
    } else if (isCellError(value)) {
      chunk.kind[i] = Kind.Error;
      chunk.ref[i] = this.#pools.strings.intern(value.error);
    } else {
      throw new Error(`A cell cannot hold ${JSON.stringify(value)}.`);
    }
    chunk.filled += 1;
    this.#filled += 1;
  }

  /** Empty one row of a chunk, releasing what it referenced. */
  #clear(chunk: Chunk, i: number): void {
    const kind = chunk.kind[i] as Kind;
    if (kind === Kind.Empty && chunk.style[i] === 0) return;
    if (kind === Kind.String || kind === Kind.Error) this.#pools.strings.release(chunk.ref[i]);
    else if (kind === Kind.Formula) this.#pools.formulas.remove(chunk.ref[i]);
    chunk.kind[i] = Kind.Empty;
    chunk.num[i] = 0;
    chunk.ref[i] = 0;
    chunk.style[i] = 0;
    chunk.filled -= 1;
    this.#filled -= 1;
  }
}
