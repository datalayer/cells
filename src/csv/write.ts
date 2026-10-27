/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Writing CSV: a sheet (its used cells) or a zone, values as they are or
 * formulas as typed, fields quoted when they must be (a delimiter, a quote, a
 * line break, spaces at an end), lines ended with CRLF as RFC 4180 says. As
 * one string, or as a `ReadableStream` of pieces for a large sheet.
 *
 * @module csv/write
 */

import type { CellsModel } from '../core/model.js';
import { type CellValue, isCellError } from '../core/values.js';
import type { Zone } from '../core/zone.js';
import { numberToText } from '../formula/values.js';
import type { Delimiter } from './parse.js';

export interface CsvWriteOptions {
  /** The sheet (the active one by default). */
  readonly sheet?: string;
  /** The zone (the sheet's used cells by default). */
  readonly zone?: Zone;
  readonly delimiter?: Delimiter;
  /** `true`: a formula is written as typed (`=SUM(A1:A3)`), not as its value. */
  readonly formulas?: boolean;
}

function field(v: CellValue, delimiter: string): string {
  let s: string;
  if (v === null) return '';
  if (typeof v === 'number') s = numberToText(v);
  else if (typeof v === 'boolean') s = v ? 'TRUE' : 'FALSE';
  else if (isCellError(v)) s = v.error;
  else s = v;
  if (
    s.includes(delimiter) ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r') ||
    s !== s.trim()
  )
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** The zone a sheet's cells use: from A1 to the last row and column holding something. */
export function usedZone(model: CellsModel, sheet: string): Zone {
  const cells = model.sheet(sheet).cells;
  let right = 0;
  let bottom = 0;
  for (const c of cells.columnIndexes()) {
    const last = cells.lastRowIn(c);
    if (last >= 0) {
      right = Math.max(right, c);
      bottom = Math.max(bottom, last);
    }
  }
  return { top: 0, left: 0, bottom, right };
}

function* lines(model: CellsModel, options: CsvWriteOptions): Generator<string> {
  const sheet = options.sheet ?? model.selection.sheet;
  const zone = options.zone ?? usedZone(model, sheet);
  const d = options.delimiter ?? ',';
  for (let r = zone.top; r <= zone.bottom; r += 1) {
    const out: string[] = [];
    for (let c = zone.left; c <= zone.right; c += 1) {
      const content = options.formulas ? model.content(sheet, r, c) : null;
      out.push(
        content?.formula !== undefined
          ? field(`=${content.formula}`, d)
          : field(model.value(sheet, r, c), d),
      );
    }
    yield `${out.join(d)}\r\n`;
  }
}

/** A sheet or zone as CSV text. */
export function toCsv(model: CellsModel, options: CsvWriteOptions = {}): string {
  let out = '';
  for (const line of lines(model, options)) out += line;
  return out;
}

/** A sheet or zone as a stream of CSV text, 10,000 lines a piece. */
export function csvStream(
  model: CellsModel,
  options: CsvWriteOptions = {},
): ReadableStream<string> {
  const it = lines(model, options);
  return new ReadableStream<string>({
    pull(controller) {
      let piece = '';
      for (let i = 0; i < 10_000; i += 1) {
        const next = it.next();
        if (next.done) {
          if (piece !== '') controller.enqueue(piece);
          controller.close();
          return;
        }
        piece += next.value;
      }
      controller.enqueue(piece);
    },
  });
}
