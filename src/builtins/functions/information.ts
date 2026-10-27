/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** @module builtins/functions/information */

import { type CellValue, isCellError } from '../../core/values.js';
import { fail } from '../../formula/values.js';
import type { FormulaFunction } from '../../points/index.js';
import { fn } from './args.js';

const is = (name: string, description: string, example: string, test: (v: CellValue) => boolean) =>
  fn(name, 'information', 'value:a', 'boolean', description, [example], ([v]) =>
    test(v as CellValue),
  );

export const INFORMATION: readonly FormulaFunction[] = [
  is('ISBLANK', 'Whether a cell is empty.', '=ISBLANK(Z99) → TRUE', (v) => v === null),
  is(
    'ISNUMBER',
    'Whether a value is a number.',
    '=ISNUMBER(1) → TRUE',
    (v) => typeof v === 'number',
  ),
  is('ISTEXT', 'Whether a value is text.', '=ISTEXT("a") → TRUE', (v) => typeof v === 'string'),
  is(
    'ISLOGICAL',
    'Whether a value is TRUE or FALSE.',
    '=ISLOGICAL(TRUE) → TRUE',
    (v) => typeof v === 'boolean',
  ),
  is('ISERROR', 'Whether a value is an error.', '=ISERROR(1/0) → TRUE', (v) => isCellError(v)),
  is(
    'ISERR',
    'Whether a value is an error other than #N/A.',
    '=ISERR(NA()) → FALSE',
    (v) => isCellError(v) && v.error !== '#N/A',
  ),
  is(
    'ISNA',
    'Whether a value is #N/A.',
    '=ISNA(NA()) → TRUE',
    (v) => isCellError(v) && v.error === '#N/A',
  ),
  fn('NA', 'information', '', 'any', 'The #N/A error: no value available.', ['=NA() → #N/A'], () =>
    fail('#N/A', 'No value available.'),
  ),
  fn(
    'N',
    'information',
    'value:a',
    'number',
    'A number as it is, TRUE as 1, anything else as 0.',
    ['=N(TRUE) → 1'],
    ([v]) => {
      if (isCellError(v)) return v;
      return typeof v === 'number' ? v : v === true ? 1 : 0;
    },
  ),
];
