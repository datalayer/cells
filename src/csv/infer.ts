/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What a CSV field holds: a number (in the file's locale), a percentage, a
 * boolean, a date (as a serial, with a date format), or text. Inference can
 * be switched off: everything is then text.
 *
 * @module csv/infer
 */

import type { CellValue } from '../core/values.js';

/** How a CSV field's type is inferred (numbers, booleans, dates), or not. */
export interface InferOptions {
  /** `false`: every field is text. */
  readonly infer?: boolean;
  /** The decimal mark of numbers in the file: `.` (the default) or `,`. */
  readonly decimal?: '.' | ',';
  /** How dates with slashes read: month first (the default, en-US) or day first. */
  readonly dates?: 'mdy' | 'dmy';
}

/** A field's value, and the number format it shows in when the text said one (a date, a percentage). */
export interface Inferred {
  readonly value: CellValue;
  readonly format?: string;
}

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86_400_000;

function serial(y: number, m: number, d: number): number | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const t = Date.UTC(y, m - 1, d);
  if (new Date(t).getUTCDate() !== d) return undefined;
  const days = Math.round((t - EPOCH) / DAY);
  // Before 1900 a date is no serial (Excel keeps such dates as text).
  if (days < 2) return undefined;
  return days < 61 ? days - 1 : days;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** A CSV field's text as a value: a number, a boolean, a date with its format, or text. */
export function inferField(text: string, options: InferOptions = {}): Inferred {
  if (text === '') return { value: null };
  if (options.infer === false) return { value: text };
  const t = text.trim();
  const decimal = options.decimal ?? '.';
  const group = decimal === '.' ? ',' : '.';
  // A number: optional sign, digits with groups of three, a decimal part, an exponent.
  const percent = t.endsWith('%');
  const body = percent ? t.slice(0, -1).trim() : t;
  const groups =
    decimal === '.' ? /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/ : /^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/;
  const plain =
    decimal === '.'
      ? /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
      : /^[+-]?(\d+,?\d*|,\d+)([eE][+-]?\d+)?$/;
  if (plain.test(body) || groups.test(body)) {
    const normal = body.split(group).join('').replace(decimal, '.');
    const n = Number(normal);
    if (Number.isFinite(n)) {
      // Leading zeros are an identifier (a postcode, a code), not a number.
      if (/^[+-]?0\d/.test(body) && !body.includes(decimal)) return { value: text };
      return percent ? { value: n / 100, format: '0%' } : { value: n };
    }
  }
  const upper = t.toUpperCase();
  if (upper === 'TRUE') return { value: true };
  if (upper === 'FALSE') return { value: false };
  let m = ISO.exec(t);
  if (m) {
    const day = serial(Number(m[1]), Number(m[2]), Number(m[3]));
    if (day !== undefined) {
      if (m[4] === undefined) return { value: day, format: 'yyyy-mm-dd' };
      const time = (Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6] ?? 0)) / 86_400;
      return { value: day + time, format: 'yyyy-mm-dd hh:mm:ss' };
    }
  }
  m = SLASHED.exec(t);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const day = options.dates === 'dmy' ? serial(Number(m[3]), b, a) : serial(Number(m[3]), a, b);
    if (day !== undefined)
      return { value: day, format: options.dates === 'dmy' ? 'd/m/yyyy' : 'm/d/yyyy' };
  }
  return { value: text };
}
