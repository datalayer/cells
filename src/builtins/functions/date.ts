/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Dates are serials in Excel's 1900 system (1 is 1 January 1900; 60 is the
 * 29 February 1900 Excel keeps for compatibility); times are fractions of a day.
 *
 * @module builtins/functions/date
 */

import { fail } from '../../formula/values.js';
import type { FormulaFunction } from '../../points/index.js';
import { dateArg, daysIn, fn, grid, int, now, num, parseDate, serial, text, ymd } from './args.js';

/** A time's hours, minutes and seconds, rounded to the second as Excel shows them. */
function hms(v: unknown): { h: number; m: number; s: number } {
  const x = num(v);
  if (x < 0) fail('#NUM!', 'A negative time.');
  const seconds = Math.round((x - Math.floor(x)) * 86_400) % 86_400;
  return { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60), s: seconds % 60 };
}

/** A date `months` later, its day kept or clamped to the month's last. */
function addMonths(start: number, months: number, end: boolean): number {
  const { year, month, day } = ymd(start);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = daysIn(y, m);
  return serial(y, m, end ? last : Math.min(day, last));
}

const WEEKDAY_TYPES: Record<number, (w: number) => number> = {
  1: (w) => w + 1,
  2: (w) => ((w + 6) % 7) + 1,
  3: (w) => (w + 6) % 7,
};

export const DATE: readonly FormulaFunction[] = [
  fn(
    'DATE',
    'date',
    'year:n month:n day:n',
    'number',
    'The date of a year, month and day; months and days past their end carry over.',
    ['=DATE(2024, 2, 29) → 45351'],
    ([y, m, d]) => {
      const year = int(y);
      if (year < 0 || year > 9999) fail('#NUM!', 'A year from 0 to 9999.');
      const n = serial(year, int(m), int(d));
      return n < 0 ? fail('#NUM!', 'A date before 1900.') : n;
    },
  ),
  fn(
    'TIME',
    'date',
    'hour:n minute:n second:n',
    'number',
    'A time of day, as a fraction of a day.',
    ['=TIME(13, 30, 0) → 0.5625'],
    ([h, m, s]) => {
      const t = int(h) * 3600 + int(m) * 60 + int(s);
      if (t < 0) fail('#NUM!', 'A negative time.');
      return (t % 86_400) / 86_400;
    },
  ),
  fn(
    'YEAR',
    'date',
    'date:n',
    'number',
    'The year of a date.',
    ['=YEAR(45000) → 2023'],
    ([d]) => ymd(dateArg(d)).year,
  ),
  fn(
    'MONTH',
    'date',
    'date:n',
    'number',
    'The month of a date, 1 to 12.',
    ['=MONTH(45000) → 3'],
    ([d]) => ymd(dateArg(d)).month,
  ),
  fn(
    'DAY',
    'date',
    'date:n',
    'number',
    'The day of a date’s month.',
    ['=DAY(45000) → 15'],
    ([d]) => ymd(dateArg(d)).day,
  ),
  fn(
    'HOUR',
    'date',
    'time:n',
    'number',
    'The hour of a time, 0 to 23.',
    ['=HOUR(0.75) → 18'],
    ([t]) => hms(t).h,
  ),
  fn(
    'MINUTE',
    'date',
    'time:n',
    'number',
    'The minute of a time.',
    ['=MINUTE(0.7604166667) → 15'],
    ([t]) => hms(t).m,
  ),
  fn(
    'SECOND',
    'date',
    'time:n',
    'number',
    'The second of a time.',
    ['=SECOND(0.5000115741) → 1'],
    ([t]) => hms(t).s,
  ),
  fn(
    'EDATE',
    'date',
    'start:n months:n',
    'number',
    'The date some months before or after.',
    ['=EDATE(45000, 1) → 45031'],
    ([d, m]) => addMonths(dateArg(d), int(m), false),
  ),
  fn(
    'EOMONTH',
    'date',
    'start:n months:n',
    'number',
    'The last day of the month some months before or after.',
    ['=EOMONTH(45000, 0) → 45016'],
    ([d, m]) => addMonths(dateArg(d), int(m), true),
  ),
  fn(
    'NETWORKDAYS',
    'date',
    'start:n end:n holidays:r?',
    'number',
    'How many weekdays (Monday to Friday) from one date to another, both included, holidays left out.',
    ['=NETWORKDAYS(45000, 45030) → 23'],
    ([a, b, holidays], c) => {
      let start = Math.floor(dateArg(a));
      let end = Math.floor(dateArg(b));
      const sign = start <= end ? 1 : -1;
      if (sign < 0) [start, end] = [end, start];
      const off = new Set<number>();
      if (holidays !== undefined) {
        const g = grid(holidays, c);
        for (let r = 0; r < g.rows; r += 1)
          for (let k = 0; k < g.cols; k += 1) {
            const v = g.get(r, k);
            if (typeof v === 'number') off.add(Math.floor(v));
          }
      }
      let n = 0;
      for (let d = start; d <= end; d += 1) {
        const w = ymd(d).weekday;
        if (w !== 0 && w !== 6 && !off.has(d)) n += 1;
      }
      return sign * n;
    },
  ),
  fn(
    'WEEKDAY',
    'date',
    'date:n type:n?',
    'number',
    'The day of the week: 1 Sunday to 7 Saturday (type 1), 1 Monday to 7 Sunday (2), 0 Monday to 6 Sunday (3).',
    ['=WEEKDAY(45000) → 4'],
    ([d, t]) => {
      const f = WEEKDAY_TYPES[int(t, 1)];
      return f === undefined ? fail('#NUM!', 'The type is 1, 2 or 3.') : f(ymd(dateArg(d)).weekday);
    },
  ),
  fn(
    'WEEKNUM',
    'date',
    'date:n type:n?',
    'number',
    'The week of the year, week 1 holding 1 January; weeks start on Sunday (type 1) or Monday (2).',
    ['=WEEKNUM(45000) → 11'],
    ([d, t]) => {
      const type = int(t, 1);
      if (type !== 1 && type !== 2) fail('#NUM!', 'The type is 1 or 2.');
      const x = Math.floor(dateArg(d));
      const jan1 = serial(ymd(x).year, 1, 1);
      const shift = type === 1 ? ymd(jan1).weekday : (ymd(jan1).weekday + 6) % 7;
      return Math.floor((x - jan1 + shift) / 7) + 1;
    },
  ),
  fn(
    'DATEDIF',
    'date',
    'start:n end:n unit:n',
    'number',
    'The years ("y"), months ("m"), days ("d") between two dates, or the days and months left over ("md", "ym", "yd").',
    ['=DATEDIF(45000, 45366, "m") → 12'],
    ([a, b, u]) => {
      const start = Math.floor(dateArg(a));
      const end = Math.floor(dateArg(b));
      if (start > end) fail('#NUM!', 'The start is after the end.');
      const s = ymd(start);
      const e = ymd(end);
      let months = (e.year - s.year) * 12 + (e.month - s.month);
      if (e.day < s.day) months -= 1;
      switch (text(u).toUpperCase()) {
        case 'Y':
          return Math.floor(months / 12);
        case 'M':
          return months;
        case 'D':
          return end - start;
        case 'MD': {
          const d = e.day - s.day;
          return d >= 0 ? d : daysIn(...prevMonth(e.year, e.month)) - s.day + e.day;
        }
        case 'YM':
          return months % 12;
        case 'YD': {
          let anniversary = serial(e.year, s.month, s.day);
          if (anniversary > end) anniversary = serial(e.year - 1, s.month, s.day);
          return end - anniversary;
        }
        default:
          return fail('#NUM!', 'The unit is "y", "m", "d", "md", "ym" or "yd".');
      }
    },
  ),
  fn(
    'DAYS',
    'date',
    'end:n start:n',
    'number',
    'How many days from one date to another.',
    ['=DAYS(45366, 45000) → 366'],
    ([e, s]) => Math.floor(dateArg(e)) - Math.floor(dateArg(s)),
  ),
  fn(
    'DATEVALUE',
    'date',
    'text:n',
    'number',
    'Text read as a date.',
    ['=DATEVALUE("2023-03-15") → 45000'],
    ([t]) => parseDate(text(t)) ?? fail('#VALUE!', `'${text(t)}' is not a date.`),
  ),
  fn('TODAY', 'date', '', 'number', 'Today’s date.', ['=TODAY()'], () => Math.floor(now()), {
    volatile: true,
  }),
  fn('NOW', 'date', '', 'number', 'The date and time now.', ['=NOW()'], () => now(), {
    volatile: true,
  }),
];

const prevMonth = (y: number, m: number): [number, number] => (m === 1 ? [y - 1, 12] : [y, m - 1]);
