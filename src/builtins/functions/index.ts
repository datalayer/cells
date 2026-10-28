/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The built-in formula functions, contributed to `datalayer.cells.function`
 * as a third-party plugin's would be. Each carries its arguments' kinds (the
 * evaluator reads them: scalars are coerced and their errors stop the call,
 * ranges are passed as references, lazy arguments are computed on demand),
 * a category, a description and examples.
 *
 * @module builtins/functions
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { CellsFunctions, type FormulaFunction } from '../../points/index.js';
import { DATE } from './date.js';
import { INFORMATION } from './information.js';
import { LOGIC } from './logic.js';
import { LOOKUP } from './lookup.js';
import { MATH } from './math.js';
import { STATISTICS } from './statistics.js';
import { TEXT } from './text.js';

export { numbers } from './args.js';

/** The name of `CellsFunctionsPlugin`. */
export const CELLS_FUNCTIONS_PLUGIN = '@datalayer/cells-functions';

/** Every built-in function, by category. */
export const FUNCTIONS: readonly FormulaFunction[] = [
  ...MATH,
  ...STATISTICS,
  ...LOGIC,
  ...TEXT,
  ...LOOKUP,
  ...DATE,
  ...INFORMATION,
];

/** The built-in formula functions (about a hundred), through `datalayer.cells.function`. */
export const CellsFunctionsPlugin = definePlugin({
  name: CELLS_FUNCTIONS_PLUGIN,
  displayName: 'Cells functions',
  description: 'The built-in formula functions.',
  octicon: 'number',
  contributes: FUNCTIONS.map((f) => contribution(CellsFunctions, f, { id: f.name, order: 100 })),
});
