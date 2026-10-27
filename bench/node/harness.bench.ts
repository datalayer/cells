/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The harness's own figure: a bench that does nothing. Proves the runner,
 * the result file and the comparison end to end before anything is measured.
 * A bench's name is the figure it measures (bench/budgets.json).
 */

import { bench } from 'vitest';

bench('harness.noop.ms', () => {
  // Nothing: the cost of the harness itself.
});
