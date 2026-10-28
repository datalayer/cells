/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Rows of CSV fields into column chunks: per column, a kind and a number per
 * row in typed arrays (transferable from a worker without a copy), the texts
 * apart, and a format index per row. A chunk decodes into the columns and
 * formats `CellsModel.loadColumns` takes.
 *
 * @module csv/chunks
 */

import type { CellValue } from '../core/values.js';
import { type InferOptions, inferField } from './infer.js';
import { CsvParser, type Delimiter } from './parse.js';

const enum Kind {
  Empty = 0,
  Number = 1,
  Text = 2,
  True = 3,
  False = 4,
}

/** One column of a parsed CSV chunk, columnar: kinds, numbers and strings. */
export interface CsvColumn {
  readonly kinds: Uint8Array;
  readonly numbers: Float64Array;
  /** Texts by row, for text cells only. */
  readonly texts: (string | undefined)[];
  /** An index into the chunk's formats, plus one; 0 is none. */
  readonly formats: Uint8Array;
}

/** A block of parsed CSV rows, as the parser hands them on (in a worker or not). */
export interface CsvChunk {
  /** The chunk's first row in the file (0 is the first line). */
  readonly row: number;
  readonly rows: number;
  readonly columns: CsvColumn[];
  readonly formats: string[];
}

/** How a CSV file is read: its delimiter, encoding, header and type inference. */
export interface CsvReadOptions extends InferOptions {
  readonly delimiter?: Delimiter;
  /** Rows per chunk: 4,096 by default (a chunk loads into the model in one main-thread task). */
  readonly chunkRows?: number;
}

/** The buffers of a chunk, for `postMessage`'s transfer list. */
export function transferables(chunk: CsvChunk): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const c of chunk.columns)
    out.push(
      c.kinds.buffer as ArrayBuffer,
      c.numbers.buffer as ArrayBuffer,
      c.formats.buffer as ArrayBuffer,
    );
  return out;
}

/** Collects rows into chunks of `size` rows. */
export class ChunkBuilder {
  #rows: string[][] = [];
  #next = 0;
  readonly #size: number;
  readonly #options: InferOptions;
  readonly #emit: (chunk: CsvChunk) => void;
  width = 0;

  constructor(options: CsvReadOptions, emit: (chunk: CsvChunk) => void) {
    this.#size = options.chunkRows ?? 4_096;
    this.#options = options;
    this.#emit = emit;
  }

  add(row: string[]): void {
    this.#rows.push(row);
    if (row.length > this.width) this.width = row.length;
    if (this.#rows.length >= this.#size) this.flush();
  }

  /** The rows read so far. */
  get count(): number {
    return this.#next + this.#rows.length;
  }

  flush(): void {
    const rows = this.#rows;
    if (rows.length === 0) return;
    this.#rows = [];
    let width = 0;
    for (const r of rows) if (r.length > width) width = r.length;
    const formats: string[] = [];
    const formatIndex = new Map<string, number>();
    const columns: CsvColumn[] = [];
    for (let c = 0; c < width; c += 1) {
      const kinds = new Uint8Array(rows.length);
      const numbers = new Float64Array(rows.length);
      const texts: (string | undefined)[] = [];
      const fmt = new Uint8Array(rows.length);
      for (let r = 0; r < rows.length; r += 1) {
        const field = rows[r][c];
        if (field === undefined || field === '') continue;
        const { value, format } = inferField(field, this.#options);
        if (typeof value === 'number') {
          kinds[r] = Kind.Number;
          numbers[r] = value;
        } else if (value === true) kinds[r] = Kind.True;
        else if (value === false) kinds[r] = Kind.False;
        else if (typeof value === 'string') {
          kinds[r] = Kind.Text;
          texts[r] = value;
        }
        if (format !== undefined) {
          let k = formatIndex.get(format);
          if (k === undefined) {
            formats.push(format);
            k = formats.length;
            formatIndex.set(format, k);
          }
          if (k > 255) throw new Error('More than 255 number formats in one CSV chunk.');
          fmt[r] = k;
        }
      }
      columns.push({ kinds, numbers, texts, formats: fmt });
    }
    const chunk: CsvChunk = { row: this.#next, rows: rows.length, columns, formats };
    this.#next += rows.length;
    this.#emit(chunk);
  }
}

/** A chunk as the columns and formats `loadColumns` takes. */
export function decodeChunk(chunk: CsvChunk): {
  columns: CellValue[][];
  formats: (string | undefined)[][];
} {
  const columns: CellValue[][] = [];
  const formats: (string | undefined)[][] = [];
  for (const c of chunk.columns) {
    const values: CellValue[] = new Array(chunk.rows);
    const fmts: (string | undefined)[] = new Array(chunk.rows);
    for (let r = 0; r < chunk.rows; r += 1) {
      switch (c.kinds[r] as Kind) {
        case Kind.Number:
          values[r] = c.numbers[r];
          break;
        case Kind.Text:
          values[r] = c.texts[r]!;
          break;
        case Kind.True:
          values[r] = true;
          break;
        case Kind.False:
          values[r] = false;
          break;
        default:
          values[r] = null;
      }
      const f = c.formats[r];
      fmts[r] = f === 0 ? undefined : chunk.formats[f - 1];
    }
    columns.push(values);
    formats.push(fmts);
  }
  return { columns, formats };
}

/** Parse text in pieces into chunks; resolves with the delimiter used and the rows read. */
export async function parseToChunks(
  pieces: AsyncIterable<string> | Iterable<string>,
  options: CsvReadOptions,
  emit: (chunk: CsvChunk) => void,
): Promise<{ delimiter: Delimiter; rows: number; cols: number }> {
  const builder = new ChunkBuilder(options, emit);
  const parser = new CsvParser((row) => builder.add(row), options.delimiter);
  for await (const piece of pieces) parser.push(piece);
  parser.end();
  builder.flush();
  return { delimiter: parser.delimiter ?? ',', rows: builder.count, cols: builder.width };
}
