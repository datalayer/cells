/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { best, overBudget } from '../best.mjs';
import budgets from '../budgets.json';

describe('the best attempt of a timing', () => {
  it('names the figures over their budget, and only those', () => {
    const figures = {
      'recalc.full.ms': { value: 3418, unit: 'ms' },
      'recalc.wide.ms': { value: 13, unit: 'ms' },
    };
    expect(overBudget(figures, budgets)).toEqual(['recalc.full.ms']);
  });

  it('keeps the lowest value of each figure and counts its attempts', () => {
    const first = best({}, { 'recalc.full.ms': { value: 3418, unit: 'ms' } });
    const second = best(first, { 'recalc.full.ms': { value: 907, unit: 'ms' } });
    const third = best(second, { 'recalc.full.ms': { value: 1200, unit: 'ms' } });
    expect(third['recalc.full.ms']).toEqual({ value: 907, unit: 'ms', attempts: 3 });
  });

  it('still fails a regression that slows every attempt', () => {
    let figures = {};
    for (const value of [1300, 1250, 1400])
      figures = best(figures, { 'recalc.full.ms': { value, unit: 'ms' } });
    expect(overBudget(figures, budgets)).toEqual(['recalc.full.ms']);
  });
});
