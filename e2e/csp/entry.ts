/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// Evaluates formulas on a page whose policy forbids eval: the CSP spec bundles
// this file and serves it as the page's only script.
import { createCellsModel } from '../../src/core/index.js';

let evalBlocked = false;
try {
  new Function('return 1')();
} catch {
  evalBlocked = true;
}

const model = createCellsModel({ limits: { rows: 100, cols: 10 } });
model.dispatch({
  type: 'SET_CELLS',
  sheet: 's1',
  at: { row: 0, col: 0 },
  cells: [
    [1, { formula: 'A1*2+$A$1' }],
    [2, null],
    [3, { formula: 'SUM(A1:A3)' }],
  ],
});
model.dispatch({
  type: 'FILL',
  sheet: 's1',
  source: { top: 0, left: 1, bottom: 0, right: 1 },
  target: { top: 0, left: 1, bottom: 1, right: 1 },
});
const out = {
  evalBlocked,
  values: model.toRows({ top: 0, left: 1, bottom: 2, right: 1 }).map((r) => r[0]),
};
document.body.dataset.result = JSON.stringify(out);
