/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { compare } from '../compare.mjs';
import budgets from '../budgets.json';

const result = (value: number) => ({ figures: { 'harness.noop.ms': { value, unit: 'ms' } } });

describe('the bench comparison', () => {
  it('passes on equal figures', () => {
    const { ok, failures } = compare(result(0.5), result(0.5), budgets);
    expect(failures).toEqual([]);
    expect(ok).toBe(true);
  });

  it('fails on a 20 % regression, naming the figure', () => {
    const { ok, failures } = compare(result(0.5), result(0.6), budgets);
    expect(ok).toBe(false);
    expect(failures[0]).toMatch(/harness\.noop\.ms: 0\.6 ms regressed 20\.0 %/);
  });

  it('passes on a 10 % regression, under the threshold', () => {
    expect(compare(result(0.5), result(0.55), budgets).ok).toBe(true);
  });

  it('fails on a figure over its budget, even without a base', () => {
    const { ok, failures } = compare(null, result(2), budgets);
    expect(ok).toBe(false);
    expect(failures[0]).toMatch(/over its budget of 1/);
  });

  it('refuses a figure no budget declares', () => {
    const { ok, failures } = compare(
      null,
      { figures: { 'made.up': { value: 1, unit: 'ms' } } },
      budgets,
    );
    expect(ok).toBe(false);
    expect(failures[0]).toMatch(/no budget declares/);
  });

  it('refuses a figure measured in another unit than its budget', () => {
    const current = { figures: { 'harness.noop.ms': { value: 0.1, unit: 's' } } };
    expect(compare(null, current, budgets).failures[0]).toMatch(/measured in s, budgeted in ms/);
  });

  it('refuses an empty result', () => {
    expect(compare(null, { figures: {} }, budgets).ok).toBe(false);
  });
});
