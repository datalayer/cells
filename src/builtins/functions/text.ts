/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** @module builtins/functions/text */

import { compileFormat, FormatCodeError } from '../../core/numfmt.js';
import type { CellValue } from '../../core/values.js';
import { fail, toNumber, toText } from '../../formula/values.js';
import type { FormulaFunction } from '../../points/index.js';
import { fn, grid, int, isRange, num, parseDate, text, wildcard } from './args.js';

/** A position argument, 1-based and at least 1. */
function position(v: unknown, fallback: number): number {
  const n = int(v, fallback);
  if (n < 1) fail('#VALUE!', 'A position starts at 1.');
  return n;
}

function count(v: unknown, fallback: number): number {
  const n = int(v, fallback);
  if (n < 0) fail('#VALUE!', 'A count is not negative.');
  return n;
}

export const TEXT: readonly FormulaFunction[] = [
  fn(
    'CONCAT',
    'text',
    'text1:r text2:r...',
    'string',
    'Joins texts and the values of ranges.',
    ['=CONCAT("a", 1, TRUE) → a1TRUE'],
    (a, c) => {
      let out = '';
      for (const x of a) {
        if (isRange(x)) for (const v of c.values(x)) out += toText(v);
        else out += toText(x as CellValue);
      }
      return out;
    },
  ),
  fn(
    'CONCATENATE',
    'text',
    'text1:n text2:n...',
    'string',
    'Joins texts.',
    ['=CONCATENATE("a", 1) → a1'],
    (a) => a.map((x) => toText(x as CellValue)).join(''),
  ),
  fn(
    'TEXTJOIN',
    'text',
    'delimiter:n ignore_empty:n text1:r text2:r...',
    'string',
    'Joins texts with a delimiter, empty ones left out or not.',
    ['=TEXTJOIN("-", TRUE, "a", "", "b") → a-b'],
    ([delimiter, ignore, ...rest], c) => {
      const parts: string[] = [];
      const skip = ignore !== false && ignore !== 0;
      for (const x of rest) {
        if (isRange(x)) {
          // Empty cells of a range are empty texts: kept unless empties are ignored.
          const g = grid(x, c);
          for (let r = 0; r < g.rows; r += 1)
            for (let col = 0; col < g.cols; col += 1) {
              const t = toText(g.get(r, col));
              if (!(skip && t === '')) parts.push(t);
            }
        } else {
          const t = toText(x as CellValue);
          if (!(skip && t === '')) parts.push(t);
        }
      }
      return parts.join(text(delimiter));
    },
  ),
  fn(
    'LEFT',
    'text',
    'text:n count:n?',
    'string',
    'The first characters.',
    ['=LEFT("Banana", 3) → Ban'],
    ([t, n]) => text(t).slice(0, count(n, 1)),
  ),
  fn(
    'RIGHT',
    'text',
    'text:n count:n?',
    'string',
    'The last characters.',
    ['=RIGHT("Banana", 2) → na'],
    ([t, n]) => {
      const s = text(t);
      const k = count(n, 1);
      return k === 0 ? '' : s.slice(-k);
    },
  ),
  fn(
    'MID',
    'text',
    'text:n start:n count:n',
    'string',
    'Characters from a position.',
    ['=MID("Elderberry", 2, 4) → lder'],
    ([t, start, n]) => {
      const p = position(start, 1);
      return text(t).slice(p - 1, p - 1 + count(n, 0));
    },
  ),
  fn(
    'LEN',
    'text',
    'text:n',
    'number',
    'How many characters.',
    ['=LEN("abc") → 3'],
    ([t]) => text(t).length,
  ),
  fn(
    'FIND',
    'text',
    'find:n within:n start:n?',
    'number',
    'Where a text is in another, case-sensitively.',
    ['=FIND("r", "cherry") → 4'],
    ([f, w, start]) => {
      const p = position(start, 1);
      const i = text(w).indexOf(text(f), p - 1);
      return i < 0 ? fail('#VALUE!', 'Not found.') : i + 1;
    },
  ),
  fn(
    'SEARCH',
    'text',
    'find:n within:n start:n?',
    'number',
    'Where a text is in another, any case, with wildcards.',
    ['=SEARCH("R", "cherry") → 4'],
    ([f, w, start]) => {
      const p = position(start, 1);
      const within = text(w);
      const m = wildcard(text(f), false).exec(within.slice(p - 1));
      return m === null ? fail('#VALUE!', 'Not found.') : m.index + p;
    },
  ),
  fn(
    'SUBSTITUTE',
    'text',
    'text:n old:n new:n instance:n?',
    'string',
    'Replaces a text by another: every time, or its n-th occurrence.',
    ['=SUBSTITUTE("a-b-c", "-", "+") → a+b+c'],
    ([t, o, n, instance]) => {
      const s = text(t);
      const old = text(o);
      const by = text(n);
      if (old === '') return s;
      if (instance === undefined) return s.split(old).join(by);
      const k = int(instance);
      if (k < 1) fail('#VALUE!', 'The instance starts at 1.');
      let at = -1;
      for (let i = 0; i < k; i += 1) {
        at = s.indexOf(old, at + 1);
        if (at < 0) return s;
      }
      return s.slice(0, at) + by + s.slice(at + old.length);
    },
  ),
  fn(
    'REPLACE',
    'text',
    'text:n start:n count:n new:n',
    'string',
    'Replaces characters at a position.',
    ['=REPLACE("abcdef", 2, 3, "X") → aXef'],
    ([t, start, n, by]) => {
      const s = text(t);
      const p = position(start, 1);
      return s.slice(0, p - 1) + text(by) + s.slice(p - 1 + count(n, 0));
    },
  ),
  fn(
    'TRIM',
    'text',
    'text:n',
    'string',
    'Removes spaces at both ends and doubled spaces inside.',
    ['=TRIM("  a   b  ") → a b'],
    ([t]) => text(t).replace(/ +/g, ' ').replace(/^ | $/g, ''),
  ),
  fn('UPPER', 'text', 'text:n', 'string', 'In capitals.', ['=UPPER("apple") → APPLE'], ([t]) =>
    text(t).toUpperCase(),
  ),
  fn('LOWER', 'text', 'text:n', 'string', 'In lower case.', ['=LOWER("Banana") → banana'], ([t]) =>
    text(t).toLowerCase(),
  ),
  fn(
    'PROPER',
    'text',
    'text:n',
    'string',
    'Each word capitalised.',
    ['=PROPER("hello wORLD") → Hello World'],
    ([t]) =>
      text(t)
        .toLowerCase()
        .replace(
          /(^|[^\p{L}])(\p{L})/gu,
          (_, before: string, letter: string) => before + letter.toUpperCase(),
        ),
  ),
  fn(
    'TEXT',
    'text',
    'value:n format:n',
    'string',
    'A value shown in a number format.',
    ['=TEXT(1234.5, "#,##0.00") → 1,234.50'],
    ([v, f]) => {
      try {
        return compileFormat(text(f))(v as CellValue).text;
      } catch (error) {
        if (error instanceof FormatCodeError) return fail('#VALUE!', error.message);
        throw error;
      }
    },
  ),
  fn(
    'VALUE',
    'text',
    'text:n',
    'number',
    'Text read as a number (or a date).',
    ['=VALUE("12.5") → 12.5'],
    ([t]) => {
      if (typeof t === 'number') return t;
      const s = text(t);
      const date = parseDate(s);
      return date ?? toNumber(s);
    },
  ),
  fn(
    'REPT',
    'text',
    'text:n times:n',
    'string',
    'A text repeated.',
    ['=REPT("ab", 3) → ababab'],
    ([t, n]) => text(t).repeat(count(n, 0)),
  ),
  fn(
    'EXACT',
    'text',
    'text1:n text2:n',
    'boolean',
    'Whether two texts are the same, case included.',
    ['=EXACT("a", "A") → FALSE'],
    ([a, b]) => text(a) === text(b),
  ),
  fn(
    'CHAR',
    'text',
    'code:n',
    'string',
    'The character of a code (1–255).',
    ['=CHAR(65) → A'],
    ([n]) => {
      const k = Math.trunc(num(n));
      return k < 1 || k > 255 ? fail('#VALUE!', 'A code from 1 to 255.') : String.fromCharCode(k);
    },
  ),
  fn(
    'CODE',
    'text',
    'text:n',
    'number',
    'The code of the first character.',
    ['=CODE("A") → 65'],
    ([t]) => {
      const s = text(t);
      return s === '' ? fail('#VALUE!', 'Empty text.') : s.charCodeAt(0);
    },
  ),
];
