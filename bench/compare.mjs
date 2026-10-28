/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Compare two bench result files against each other and against the budgets.
 * A figure fails when it is over its budget, or when it regressed by more
 * than the threshold (15 % by default) against the base; a size (kB) also
 * has to grow by {@link SIZE_FLOOR_KB} or more, so a small entry gaining a
 * feature (a 5 kB entry growing by 1 kB) is not a regression, while its
 * budget still caps it. Lower is better for every figure. A figure absent
 * from the base is checked against its budget only; a figure with no budget
 * is refused, so none goes unchecked.
 *
 * Result file shape:
 *   { version: 1, sha, date, machine, figures: { "<name>": { value, unit, runs? } } }
 */

/**
 * @param {{ figures: Record<string, { value: number, unit: string }> } | null} base
 * @param {{ figures: Record<string, { value: number, unit: string }> }} current
 * @param {{ budgets: Record<string, { max: number, unit: string }> }} budgets
 * @param {{ threshold?: number }} [options]
 * @returns {{ ok: boolean, lines: string[], failures: string[] }}
 */
/** The least a size has to grow, kB, before a growth over the threshold counts as a regression. */
export const SIZE_FLOOR_KB = 2;

export function compare(base, current, budgets, options = {}) {
  const threshold = options.threshold ?? 0.15;
  const lines = [];
  const failures = [];
  const names = Object.keys(current.figures).sort();
  if (names.length === 0) {
    failures.push('the result holds no figure');
  }
  for (const name of names) {
    const figure = current.figures[name];
    const budget = budgets.budgets[name];
    if (budget === undefined) {
      failures.push(`${name}: no budget declares this figure (bench/budgets.json)`);
      continue;
    }
    if (figure.unit !== budget.unit) {
      failures.push(`${name}: measured in ${figure.unit}, budgeted in ${budget.unit}`);
      continue;
    }
    if (!Number.isFinite(figure.value)) {
      failures.push(`${name}: the value ${figure.value} is not a number`);
      continue;
    }
    let line = `${name}: ${round(figure.value)} ${figure.unit} (budget ${budget.max})`;
    if (figure.value > budget.max) {
      failures.push(
        `${name}: ${round(figure.value)} ${figure.unit} is over its budget of ${budget.max}`,
      );
    }
    const before = base?.figures?.[name];
    if (before !== undefined && before.value > 0) {
      const change = (figure.value - before.value) / before.value;
      line += `, ${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)} % against ${round(before.value)}`;
      const small = figure.unit === 'kB' && figure.value - before.value < SIZE_FLOOR_KB;
      if (change > threshold && !small) {
        failures.push(
          `${name}: ${round(figure.value)} ${figure.unit} regressed ${(change * 100).toFixed(1)} % ` +
            `against ${round(before.value)} (more than ${(threshold * 100).toFixed(0)} %)`,
        );
      }
    }
    lines.push(line);
  }
  return { ok: failures.length === 0, lines, failures };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
