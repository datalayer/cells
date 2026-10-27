/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** @module builtins/functions/logic */

import { type CellValue, isCellError } from '../../core/values.js';
import { compare, fail, toBoolean } from '../../formula/values.js';
import type { FormulaFunction, FunctionContext } from '../../points/index.js';
import { fn, isRange } from './args.js';

type Lazy = () => CellValue;
const shown = (v: CellValue) => (v === null ? 0 : v);

/** The booleans of the arguments: numbers and booleans of ranges (text skipped), scalars coerced. */
function booleans(args: readonly unknown[], context: FunctionContext): boolean[] {
  const out: boolean[] = [];
  for (const a of args) {
    if (isRange(a)) {
      for (const v of context.values(a)) {
        if (isCellError(v)) fail(v.error, v.message);
        if (typeof v === 'boolean') out.push(v);
        else if (typeof v === 'number') out.push(v !== 0);
      }
    } else if (a !== null && a !== undefined) out.push(toBoolean(a as CellValue));
  }
  if (out.length === 0) fail('#VALUE!', 'No logical value.');
  return out;
}

const LOGICALS = 'logical1:r logical2:r...';

export const LOGIC: readonly FormulaFunction[] = [
  fn(
    'IF',
    'logic',
    'condition:n then:l else:l?',
    'any',
    'One value when the condition holds, another when it does not.',
    ['=IF(2 > 1, "yes", "no") → yes'],
    ([cond, then, otherwise]) => {
      const branch = toBoolean(cond as CellValue) ? then : otherwise;
      return branch === undefined ? false : shown((branch as Lazy)());
    },
  ),
  fn(
    'IFS',
    'logic',
    'condition1:l value1:l more:l...',
    'any',
    'The value of the first condition that holds.',
    ['=IFS(1 > 2, "a", TRUE, "b") → b'],
    (a) => {
      if (a.length % 2 !== 0) fail('#VALUE!', 'Conditions and values come in pairs.');
      for (let i = 0; i < a.length; i += 2) {
        const cond = (a[i] as Lazy)();
        if (isCellError(cond)) return cond;
        if (toBoolean(cond)) return shown((a[i + 1] as Lazy)());
      }
      return fail('#N/A', 'No condition holds.');
    },
  ),
  fn(
    'IFERROR',
    'logic',
    'value:a otherwise:l',
    'any',
    'The value, or another when the value is an error.',
    ['=IFERROR(1/0, "none") → none'],
    ([v, otherwise]) => shown(isCellError(v) ? (otherwise as Lazy)() : (v as CellValue)),
  ),
  fn(
    'IFNA',
    'logic',
    'value:a otherwise:l',
    'any',
    'The value, or another when the value is #N/A.',
    ['=IFNA(NA(), "none") → none'],
    ([v, otherwise]) =>
      shown(isCellError(v) && v.error === '#N/A' ? (otherwise as Lazy)() : (v as CellValue)),
  ),
  fn(
    'AND',
    'logic',
    LOGICALS,
    'boolean',
    'Whether every value is true.',
    ['=AND(TRUE, 1 > 0) → TRUE'],
    (a, c) => booleans(a, c).every(Boolean),
  ),
  fn(
    'OR',
    'logic',
    LOGICALS,
    'boolean',
    'Whether any value is true.',
    ['=OR(FALSE, 1 > 0) → TRUE'],
    (a, c) => booleans(a, c).some(Boolean),
  ),
  fn(
    'XOR',
    'logic',
    LOGICALS,
    'boolean',
    'Whether an odd number of values are true.',
    ['=XOR(TRUE, TRUE, TRUE) → TRUE'],
    (a, c) => booleans(a, c).filter(Boolean).length % 2 === 1,
  ),
  fn(
    'NOT',
    'logic',
    'logical:n',
    'boolean',
    'The opposite.',
    ['=NOT(TRUE) → FALSE'],
    ([v]) => !toBoolean(v as CellValue),
  ),
  fn(
    'SWITCH',
    'logic',
    'expression:n value1:l result1:l more:l...',
    'any',
    'The result paired with the first value equal to the expression, else the default.',
    ['=SWITCH(2, 1, "a", 2, "b", "z") → b'],
    ([expr, ...rest]) => {
      for (let i = 0; i + 1 < rest.length; i += 2) {
        const v = (rest[i] as Lazy)();
        if (isCellError(v)) return v;
        if (compare(expr as CellValue, v) === 0) return shown((rest[i + 1] as Lazy)());
      }
      return rest.length % 2 === 1
        ? shown((rest[rest.length - 1] as Lazy)())
        : fail('#N/A', 'No value matches.');
    },
  ),
  fn('TRUE', 'logic', '', 'boolean', 'TRUE.', ['=TRUE() → TRUE'], () => true),
  fn('FALSE', 'logic', '', 'boolean', 'FALSE.', ['=FALSE() → FALSE'], () => false),
];
