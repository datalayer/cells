/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The timing rule of the gate on a shared runner: a timing figure over its
 * budget is measured again, up to a number of attempts, and its best attempt
 * is the one gated. A busy neighbour slows one attempt; a real regression
 * slows every one of them. Sizes are exact and never measured again.
 */

/**
 * The figures of `figures` that are over their budget.
 *
 * @param {Record<string, { value: number }>} figures
 * @param {{ budgets: Record<string, { max: number }> }} budgets
 * @returns {string[]}
 */
export function overBudget(figures, budgets) {
  return Object.keys(figures)
    .filter((name) => budgets.budgets[name] !== undefined)
    .filter((name) => figures[name].value > budgets.budgets[name].max)
    .sort();
}

/**
 * Merge a new attempt into the figures so far: each figure keeps its lowest
 * value, and counts the attempts it was measured in.
 *
 * @param {Record<string, { value: number, unit: string, attempts?: number }>} sofar
 * @param {Record<string, { value: number, unit: string }>} attempt
 * @returns {Record<string, { value: number, unit: string, attempts: number }>}
 */
export function best(sofar, attempt) {
  const merged = {};
  for (const [name, figure] of Object.entries(attempt)) {
    const before = sofar[name];
    if (before === undefined) {
      merged[name] = { ...figure, attempts: 1 };
    } else {
      const lower = figure.value < before.value ? figure : before;
      merged[name] = { ...lower, attempts: (before.attempts ?? 1) + 1 };
    }
  }
  for (const [name, figure] of Object.entries(sofar)) {
    if (merged[name] === undefined) merged[name] = { ...figure, attempts: figure.attempts ?? 1 };
  }
  return merged;
}
