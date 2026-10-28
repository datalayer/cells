/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What evaluation handles: a cell value, a reference (a zone on a sheet, not
 * yet read), a union of references, or a matrix (an array constant). And
 * Excel's coercions between them.
 *
 * @module formula/values
 */

import {
  type CellError,
  type CellErrorCode,
  type CellValue,
  cellError,
  isCellError,
} from '../core/values.js';
import type { Zone } from '../core/zone.js';

/** A zone on a sheet, read lazily (aggregates walk the store's columns, not a copy). */
export interface Reference {
  readonly kind: 'ref';
  readonly sheet: string;
  readonly zone: Zone;
}

/** Rows of values: an array constant, or a range's values. */
export interface Matrix {
  readonly kind: 'matrix';
  readonly rows: readonly (readonly CellValue[])[];
}

/** References joined by the union operator: `(A1:B2,D4)`. Functions taking ranges read each. */
export interface Union {
  readonly kind: 'union';
  readonly refs: readonly Reference[];
}

/** What formula evaluation handles: a cell value, a reference, a union of references or an array. */
export type Value = CellValue | Reference | Matrix | Union;

export const isReference = (v: Value): v is Reference =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'ref';
export const isMatrix = (v: Value): v is Matrix =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'matrix';
export const isUnion = (v: Value): v is Union =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'union';
export const isError = (v: unknown): v is CellError => isCellError(v);

export const err = (code: CellErrorCode, message?: string): CellError => cellError(code, message);

/** A thrown error value: functions throw it and the evaluator turns it into the cell's value. */
export class ErrorValue extends Error {
  constructor(readonly value: CellError) {
    super(value.error);
  }
}

/** Throw an error value out of a function. */
export function fail(code: CellErrorCode, message?: string): never {
  throw new ErrorValue(err(code, message));
}

/** A number as Excel turns it to text: up to 15 significant digits. */
export function numberToText(n: number): string {
  const s = String(Number(n.toPrecision(15)));
  return s.includes('e') ? s.replace('e', 'E') : s;
}

/** A value as a number, as arithmetic reads it: text that reads as a number, TRUE as 1, empty as 0. */
export function toNumber(v: CellValue): number {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isCellError(v)) throw new ErrorValue(v);
  const t = v.trim();
  if (t === '') return fail('#VALUE!', `"${v}" is not a number.`);
  const percent = t.endsWith('%');
  const body = (percent ? t.slice(0, -1) : t).replace(/,/g, '');
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(body))
    return Number(body) / (percent ? 100 : 1);
  return fail('#VALUE!', `"${v}" is not a number.`);
}

/** A value as text, as `&` reads it. */
export function toText(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberToText(v);
  throw new ErrorValue(v);
}

/** A value as a boolean, as IF reads it: numbers by not being 0; text TRUE or FALSE only. */
export function toBoolean(v: CellValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (isCellError(v)) throw new ErrorValue(v);
  const u = v.toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return fail('#VALUE!', `"${v}" is not TRUE or FALSE.`);
}

/** Excel's order across types: numbers < text < booleans; text case-insensitively. Empty is 0 or "" as the other side asks. */
export function compare(a: CellValue, b: CellValue): number {
  if (isCellError(a)) throw new ErrorValue(a);
  if (isCellError(b)) throw new ErrorValue(b);
  const x = a === null ? (typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0) : a;
  const y = b === null ? (typeof x === 'string' ? '' : typeof x === 'boolean' ? false : 0) : b;
  const rank = (v: number | string | boolean) =>
    typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
  const rx = rank(x as never);
  const ry = rank(y as never);
  if (rx !== ry) return rx - ry;
  if (typeof x === 'string') {
    const l = x.toLowerCase();
    const r = (y as string).toLowerCase();
    return l < r ? -1 : l > r ? 1 : 0;
  }
  return Number(x) - Number(y);
}
