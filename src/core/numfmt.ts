/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Excel number formats: a format code compiled once into a function, cached
 * by code. The common grammar: up to four sections (positive; negative;
 * zero; text) or conditions (`[>=100]`), colours (`[Red]`), digit
 * placeholders (`0 # ?`), the decimal point, thousands separators and
 * scaling commas, `%`, scientific (`0.00E+00`), text (`@`), literals (`"…"`,
 * `\c`, `_x` spacing, `*x` fill), dates and times (`yyyy mmm d h:mm:ss`,
 * `AM/PM`, elapsed `[h]`, fractions of a second). Not covered: fractions
 * (`# ?/?`) and locale codes (`[$-409]`), refused with a sentence.
 *
 * Checked against LibreOffice: tests/format/numfmt holds what it shows for
 * each case.
 *
 * @module core/numfmt
 */

import type { CellValue } from './values.js';
import { isCellError } from './values.js';

/** Decimal and group separators, month and day names a number format is shown with. */
export interface NumberLocale {
  readonly decimal: string;
  readonly group: string;
  readonly months: readonly string[];
  readonly days: readonly string[];
}

/** The en-US number locale, the default. */
export const EN_US: NumberLocale = {
  decimal: '.',
  group: ',',
  months: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

/** A value as a number format shows it: its text, and the colour the format asks for. */
export interface Formatted {
  readonly text: string;
  /** A colour the format asks for (`[Red]`), as a CSS colour. */
  readonly color?: string;
}

/** A refusal to compile a format code, naming what is wrong. */
export class FormatCodeError extends Error {}

type Token =
  | { t: 'lit'; s: string }
  | { t: 'digit'; c: '0' | '#' | '?' }
  | { t: 'point' }
  | { t: 'comma' }
  | { t: 'percent' }
  | { t: 'exp'; sign: '+' | '-' }
  | { t: 'text' }
  | { t: 'date'; s: string }
  | { t: 'ampm'; s: string }
  | { t: 'elapsed'; unit: 'h' | 'm' | 's'; width: number }
  | { t: 'general' };

interface Section {
  tokens: Token[];
  color?: string;
  condition?: { op: string; value: number };
  isDate: boolean;
  isText: boolean;
  hasAmPm: boolean;
}

const COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};

/** Split a code into its sections, honouring quotes, brackets and escapes. */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) throw new FormatCodeError(`'${code}' opens a quote it never closes.`);
      cur += code.slice(i, end + 1);
      i = end;
    } else if (c === '[') {
      const end = code.indexOf(']', i + 1);
      if (end < 0) throw new FormatCodeError(`'${code}' opens a bracket it never closes.`);
      cur += code.slice(i, end + 1);
      i = end;
    } else if (c === '\\' || c === '_' || c === '*') {
      if (i + 1 >= code.length)
        throw new FormatCodeError(`'${code}' ends with ${c} and nothing after it.`);
      cur += code.slice(i, i + 2);
      i += 1;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  if (out.length > 4)
    throw new FormatCodeError(`'${code}' has ${out.length} sections; a format has at most four.`);
  return out;
}

const DATE_LETTERS = /[ymdhsYMDHS]/;

function tokenize(src: string, code: string): Section {
  const tokens: Token[] = [];
  const section: Section = { tokens, isDate: false, isText: false, hasAmPm: false };
  let i = 0;
  const lit = (s: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.t === 'lit') last.s += s;
    else tokens.push({ t: 'lit', s });
  };
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      lit(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '\\') {
      lit(src[i + 1]);
      i += 2;
    } else if (c === '_') {
      lit(' ');
      i += 2;
    } else if (c === '*') {
      // A fill character: there is no width to fill on a canvas cell's text; it shows once.
      i += 2;
    } else if (c === '[') {
      const end = src.indexOf(']', i);
      const inner = src.slice(i + 1, end);
      const lower = inner.toLowerCase();
      if (lower in COLORS) section.color = COLORS[lower];
      else if (/^color\d+$/.test(lower)) section.color = undefined;
      else if (/^(<=|>=|<>|<|>|=)-?\d+(\.\d+)?$/.test(inner)) {
        const m = /^(<=|>=|<>|<|>|=)(-?\d+(?:\.\d+)?)$/.exec(inner)!;
        section.condition = { op: m[1], value: Number(m[2]) };
      } else if (/^h+$/i.test(inner) || /^m+$/i.test(inner) || /^s+$/i.test(inner)) {
        tokens.push({
          t: 'elapsed',
          unit: inner[0].toLowerCase() as 'h' | 'm' | 's',
          width: inner.length,
        });
        section.isDate = true;
      } else if (inner.startsWith('$')) {
        // [$€-x]: a currency symbol with a locale; the symbol shows, the locale is not applied.
        lit(inner.slice(1).split('-')[0]);
      } else {
        throw new FormatCodeError(
          `'${code}': [${inner}] is not a colour, a condition or an elapsed time.`,
        );
      }
      i = end + 1;
    } else if (/^general/i.test(rest)) {
      tokens.push({ t: 'general' });
      i += 7;
    } else if (/^(am\/pm|a\/p)/i.test(rest)) {
      const s = /^am\/pm/i.test(rest) ? src.slice(i, i + 5) : src.slice(i, i + 3);
      tokens.push({ t: 'ampm', s });
      section.hasAmPm = true;
      section.isDate = true;
      i += s.length;
    } else if (c === '0' || c === '#' || c === '?') {
      tokens.push({ t: 'digit', c });
      i += 1;
    } else if (c === '.') {
      // A point after seconds is fractional seconds (ss.00); else the decimal point.
      const prev = tokens[tokens.length - 1];
      if (prev?.t === 'date' && prev.s.toLowerCase().startsWith('s')) {
        let j = i + 1;
        while (src[j] === '0') j += 1;
        tokens.push({ t: 'date', s: `.${'0'.repeat(j - i - 1)}` });
        i = j;
      } else {
        tokens.push({ t: 'point' });
        i += 1;
      }
    } else if (c === ',') {
      tokens.push({ t: 'comma' });
      i += 1;
    } else if (c === '%') {
      tokens.push({ t: 'percent' });
      i += 1;
    } else if ((c === 'E' || c === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      tokens.push({ t: 'exp', sign: src[i + 1] as '+' | '-' });
      i += 2;
    } else if (c === '@') {
      tokens.push({ t: 'text' });
      section.isText = true;
      i += 1;
    } else if (DATE_LETTERS.test(c)) {
      let j = i + 1;
      while (j < src.length && src[j].toLowerCase() === c.toLowerCase()) j += 1;
      tokens.push({ t: 'date', s: src.slice(i, j).toLowerCase() });
      section.isDate = true;
      i = j;
    } else if (c === '/' && tokens.some((t) => t.t === 'digit') && !section.isDate) {
      throw new FormatCodeError(`'${code}': fractions (# ?/?) are not supported yet.`);
    } else {
      lit(c);
      i += 1;
    }
  }
  if (section.isDate) {
    // In a date or time, separators are only text.
    for (let k = 0; k < tokens.length; k += 1) {
      const t = tokens[k];
      if (t.t === 'comma') tokens[k] = { t: 'lit', s: ',' };
      else if (t.t === 'point') tokens[k] = { t: 'lit', s: '.' };
      else if (t.t === 'percent') tokens[k] = { t: 'lit', s: '%' };
    }
  }
  // "m" is minutes after an hour or before a second, months otherwise.
  const timed = tokens.filter(
    (t): t is { t: 'date'; s: string } | { t: 'elapsed'; unit: 'h' | 'm' | 's'; width: number } =>
      t.t === 'date' || t.t === 'elapsed',
  );
  const letter = (t: (typeof timed)[number] | undefined) =>
    t === undefined ? '' : t.t === 'date' ? t.s[0] : t.unit;
  timed.forEach((t, k) => {
    if (t.t !== 'date' || t.s[0] !== 'm' || t.s.length > 2) return;
    if (letter(timed[k - 1]) === 'h' || letter(timed[k + 1]) === 's')
      t.s = t.s === 'm' ? 'mi' : 'mmi';
  });
  return section;
}

function formatGeneral(n: number, locale: NumberLocale): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  let s: string;
  if (abs >= 1e11 || abs < 1e-9) {
    s = n
      .toExponential(5)
      .replace(/\.?0+e/, 'e')
      .replace('e+', 'E+')
      .replace('e-', 'E-');
    s = s.replace(/E([+-])(\d)$/, 'E$10$2');
  } else if (Number.isInteger(n)) s = String(n);
  else {
    const intLength = String(Math.trunc(abs)).length + (n < 0 ? 1 : 0);
    const decimals = Math.max(0, Math.min(10, 11 - intLength - 1));
    s = String(Number(n.toFixed(decimals)));
  }
  return s.replace('.', locale.decimal);
}

/** Excel's serial date (1900 system, with its 1900 leap-year bug) as parts. */
function serialParts(serial: number) {
  const whole = Math.floor(serial);
  const ms = Math.round((serial - whole) * 86400000);
  // Day 60 is the 29 February 1900 that never was; days after it shift by one.
  const day = whole < 60 ? whole + 1 : whole;
  const date = new Date(Date.UTC(1899, 11, 30) + day * 86400000 - (whole < 60 ? 86400000 : 0));
  const d =
    whole === 60
      ? { y: 1900, m: 2, d: 29, dow: 4 }
      : {
          y: date.getUTCFullYear(),
          m: date.getUTCMonth() + 1,
          d: date.getUTCDate(),
          dow: date.getUTCDay(),
        };
  return { ...d, ms };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function formatDate(section: Section, value: number, locale: NumberLocale): string {
  const fracDigits = section.tokens.reduce(
    (n, t) => (t.t === 'date' && t.s.startsWith('.') ? Math.max(n, t.s.length - 1) : n),
    0,
  );
  // Round to what the format shows: whole seconds, or its fraction.
  // As LibreOffice: rounded to the fraction of a second the format shows, else cut to whole seconds.
  const unit = 86400 * 10 ** fracDigits;
  // Elapsed times round too; a clock time is cut to its whole seconds.
  const elapsed = section.tokens.some((t) => t.t === 'elapsed');
  const rounded =
    fracDigits > 0 || elapsed
      ? Math.round(value * unit) / unit
      : Math.floor(value * unit + 1e-9) / unit;
  const p = serialParts(rounded);
  const totalMs = Math.round(rounded * 86400000);
  let h = Math.floor(p.ms / 3600000);
  const mi = Math.floor((p.ms % 3600000) / 60000);
  const s = Math.floor((p.ms % 60000) / 1000);
  const frac = p.ms % 1000;
  let out = '';
  for (const t of section.tokens) {
    if (t.t === 'lit') out += t.s;
    else if (t.t === 'ampm') {
      const pm = h >= 12;
      out += t.s.length === 5 ? (pm ? 'PM' : 'AM') : pm ? 'P' : 'A';
    } else if (t.t === 'elapsed') {
      const v =
        t.unit === 'h'
          ? Math.floor(totalMs / 3600000)
          : t.unit === 'm'
            ? Math.floor(totalMs / 60000)
            : Math.floor(totalMs / 1000);
      out += pad(v, t.width);
    } else if (t.t === 'date') {
      const hours = section.hasAmPm ? ((h + 11) % 12) + 1 : h;
      switch (t.s) {
        case 'y':
        case 'yy':
          out += pad(p.y % 100, 2);
          break;
        case 'yyy':
        case 'yyyy':
          out += String(p.y);
          break;
        case 'm':
          out += String(p.m);
          break;
        case 'mm':
          out += pad(p.m, 2);
          break;
        case 'mmm':
          out += locale.months[p.m - 1].slice(0, 3);
          break;
        case 'mmmm':
          out += locale.months[p.m - 1];
          break;
        case 'mmmmm':
          out += locale.months[p.m - 1][0];
          break;
        case 'd':
          out += String(p.d);
          break;
        case 'dd':
          out += pad(p.d, 2);
          break;
        case 'ddd':
          out += locale.days[p.dow].slice(0, 3);
          break;
        case 'dddd':
          out += locale.days[p.dow];
          break;
        case 'h':
          out += String(hours);
          break;
        case 'hh':
          out += pad(hours, 2);
          break;
        case 'mi':
          out += String(mi);
          break;
        case 'mmi':
          out += pad(mi, 2);
          break;
        case 's':
          out += String(s);
          break;
        case 'ss':
          out += pad(s, 2);
          break;
        default:
          if (t.s.startsWith('.'))
            out +=
              locale.decimal + pad(Math.floor(frac / 10 ** (3 - (t.s.length - 1))), t.s.length - 1);
          else out += t.s;
      }
      void h;
    } else if (t.t === 'general') out += formatGeneral(value, locale);
  }
  h = 0;
  return out;
}

/** Fill digit placeholders right to left (integer part) or left to right (fraction). */
function fillInteger(
  digits: string,
  places: ('0' | '#' | '?')[],
  group: boolean,
  locale: NumberLocale,
): string {
  const required = places.filter((c) => c === '0').length;
  let d = digits === '0' && required === 0 ? '' : digits;
  d = d.padStart(required, '0');
  // Extra places before the first: '?' pads with spaces.
  const spaces = Math.max(0, places.filter((c) => c === '?').length + required - d.length);
  if (group) d = d.replace(/\B(?=(\d{3})+(?!\d))/g, locale.group);
  return ' '.repeat(places.includes('?') ? Math.max(0, spaces - required) : 0) + d;
}

function formatNumberSection(section: Section, value: number, locale: NumberLocale): string {
  const toks = section.tokens;
  if (toks.some((t) => t.t === 'general')) {
    return toks
      .map((t) => (t.t === 'lit' ? t.s : t.t === 'general' ? formatGeneral(value, locale) : ''))
      .join('');
  }
  let v = value;
  const percents = toks.filter((t) => t.t === 'percent').length;
  v *= 100 ** percents;
  // Commas right after the last digit placeholder (before the point or the end) scale by 1000 each.
  let lastDigit = -1;
  toks.forEach((t, k) => {
    if (t.t === 'digit') lastDigit = k;
  });
  const pointAt = toks.findIndex((t) => t.t === 'point');
  const intEnd = pointAt >= 0 ? pointAt : lastDigit + 1;
  // Scaling commas: right before the point, or right after the last digit when there is none.
  const scaling = new Set<number>();
  if (pointAt >= 0) {
    for (let k = pointAt - 1; k >= 0 && toks[k].t === 'comma'; k -= 1) scaling.add(k);
  }
  for (let k = lastDigit + 1; k < toks.length && toks[k].t === 'comma'; k += 1) scaling.add(k);
  v /= 1000 ** scaling.size;
  const expAt = toks.findIndex((t) => t.t === 'exp');
  const mantissaToks = expAt >= 0 ? toks.slice(0, expAt) : toks;
  const intPlaces: ('0' | '#' | '?')[] = [];
  const fracPlaces: ('0' | '#' | '?')[] = [];
  let seenPoint = false;
  let group = false;
  mantissaToks.forEach((t, k) => {
    if (t.t === 'point') seenPoint = true;
    else if (t.t === 'digit') (seenPoint ? fracPlaces : intPlaces).push(t.c);
    else if (t.t === 'comma' && !seenPoint && !scaling.has(k) && k < intEnd) group = true;
  });
  let exponent = 0;
  if (expAt >= 0) {
    if (v !== 0) {
      // As Excel: with #'s before the point, the exponent is a multiple of the integer places.
      const step = intPlaces.length > 1 && intPlaces[0] === '#' ? intPlaces.length : 1;
      exponent = Math.floor(Math.log10(Math.abs(v)) / step) * step;
      if (step === 1)
        exponent =
          Math.floor(Math.log10(Math.abs(v))) -
          Math.max(0, intPlaces.filter((c) => c === '0').length - 1);
      v /= 10 ** exponent;
    }
  }
  const fixed = Math.abs(v).toFixed(fracPlaces.length);
  let [intDigits, fracDigits = ''] = fixed.split('.');
  if (expAt >= 0 && fixed.startsWith('10') && intPlaces.length <= 1) {
    // Rounding carried into a new digit: 9.99E+02 → 1.00E+03.
    exponent += 1;
    const again = (Math.abs(v) / 10).toFixed(fracPlaces.length).split('.');
    intDigits = again[0];
    fracDigits = again[1] ?? '';
  }
  // Trailing #'s drop zeros; ?'s become spaces.
  let frac = '';
  for (let k = fracPlaces.length - 1, keep = false; k >= 0; k -= 1) {
    const ch = fracDigits[k];
    if (!keep && ch === '0' && fracPlaces[k] !== '0') {
      frac = (fracPlaces[k] === '?' ? ' ' : '') + frac;
      continue;
    }
    keep = true;
    frac = ch + frac;
  }
  const int = fillInteger(intDigits, intPlaces, group, locale);
  let out = '';
  let intWritten = false;
  let fracWritten = false;
  let expWritten = false;
  for (let k = 0; k < toks.length; k += 1) {
    const t = toks[k];
    if (t.t === 'lit') out += t.s;
    else if (t.t === 'percent') out += '%';
    else if (t.t === 'text') out += '';
    else if (t.t === 'digit' && (expAt < 0 || k < expAt)) {
      if (k < (pointAt >= 0 ? pointAt : Infinity) && !intWritten) {
        out += int;
        intWritten = true;
      } else if (k > pointAt && pointAt >= 0 && !fracWritten) {
        out += frac;
        fracWritten = true;
      }
    } else if (t.t === 'point') {
      if (!intWritten) {
        out += int;
        intWritten = true;
      }
      // With only #'s after it and nothing to show, the point goes too (as LibreOffice shows 3 for #.##).
      if (!(frac.trim() === '' && fracPlaces.every((c) => c === '#'))) out += locale.decimal;
    } else if (t.t === 'exp' && !expWritten) {
      const expPlaces = toks.slice(k + 1).filter((x) => x.t === 'digit').length;
      const sign = exponent < 0 ? '-' : t.sign === '+' ? '+' : '';
      out += `E${sign}${pad(Math.abs(exponent), Math.max(1, expPlaces))}`;
      expWritten = true;
    }
  }
  return out;
}

/** A compiled number format: a value in, its text (and colour) out. */
export type NumberFormatter = (value: CellValue) => Formatted;

const CACHE = new Map<string, NumberFormatter>();

/** A format code, compiled; throws a FormatCodeError naming what is wrong. Cached by code. */
export function compileFormat(code: string, locale: NumberLocale = EN_US): NumberFormatter {
  const key = locale === EN_US ? code : `${code}\u0000${locale.decimal}${locale.group}`;
  const cached = CACHE.get(key);
  if (cached) return cached;
  const parsed = sections(code).map((s) => tokenize(s, code));
  const textSection = parsed.find((s) => s.isText);
  const numeric = parsed.filter((s) => s !== textSection || parsed.length === 1);
  const hasConditions = parsed.some((s) => s.condition !== undefined);
  const pick = (n: number): { section: Section; signed: boolean } => {
    if (hasConditions) {
      for (const s of numeric) {
        const c = s.condition;
        if (c === undefined) continue;
        const ok =
          c.op === '<'
            ? n < c.value
            : c.op === '<='
              ? n <= c.value
              : c.op === '>'
                ? n > c.value
                : c.op === '>='
                  ? n >= c.value
                  : c.op === '='
                    ? n === c.value
                    : n !== c.value;
        if (ok) return { section: s, signed: c.value >= 0 && n < 0 };
      }
      const rest = numeric.find((s) => s.condition === undefined) ?? numeric[numeric.length - 1];
      return { section: rest, signed: n < 0 };
    }
    if (numeric.length >= 3 && n === 0) return { section: numeric[2], signed: false };
    if (numeric.length >= 2 && n < 0) return { section: numeric[1], signed: false };
    return { section: numeric[0], signed: n < 0 };
  };
  const formatter: NumberFormatter = (value) => {
    if (value === null) return { text: '' };
    if (isCellError(value)) return { text: value.error };
    if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
    if (typeof value === 'string') {
      const s = textSection ?? (parsed.length === 1 && parsed[0].isText ? parsed[0] : undefined);
      if (s === undefined) return { text: value };
      return {
        text: s.tokens.map((t) => (t.t === 'lit' ? t.s : t.t === 'text' ? value : '')).join(''),
        color: s.color,
      };
    }
    const { section, signed } = pick(value);
    if (section.isText) return { text: formatGeneral(value, locale) };
    // A value shown by its own negative section carries no minus but the section's.
    const magnitude = Math.abs(value);
    const body = section.isDate
      ? formatDate(section, magnitude, locale)
      : formatNumberSection(section, magnitude, locale);
    const zeroish = /^[^1-9]*$/.test(body);
    return { text: signed && !zeroish ? `-${body}` : body, color: section.color };
  };
  CACHE.set(key, formatter);
  return formatter;
}

/** Throws a sentence when a code does not compile. */
export function checkFormatCode(code: string): void {
  compileFormat(code);
}
