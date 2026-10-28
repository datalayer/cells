/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A bench result with a regression injected into it: every figure worse by
 * `fraction` (0.2: 20 % slower, 20 % bigger). CI compares it against the
 * real result to prove the regression gate fails when it should, on every
 * run, with no runner noise involved.
 */
export function inject(result, fraction) {
  if (!(fraction > 0)) throw new Error(`inject takes a positive fraction; ${fraction} was given.`);
  const figures = {};
  for (const [name, figure] of Object.entries(result.figures)) {
    figures[name] = { ...figure, value: figure.value * (1 + fraction) };
  }
  return { ...result, figures, injected: fraction };
}
