/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { compare } from '../compare.mjs';
import { inject } from '../inject.mjs';
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

  it('a size growing over the threshold but under the floor is not a regression; over both, it is', () => {
    const size = (value: number) => ({ figures: { 'bundle.chrome.kB': { value, unit: 'kB' } } });
    expect(compare(size(4.7), size(5.58), budgets).ok).toBe(true);
    const { ok, failures } = compare(size(4.7), size(7.5), budgets);
    expect(ok).toBe(false);
    expect(failures[0]).toMatch(/bundle\.chrome\.kB: 7\.5 kB regressed/);
  });

  it('a growth the user accepted is measured from the accepted value; past it, a regression still is', () => {
    const size = (value: number) => ({ figures: { 'bundle.jupyter.kB': { value, unit: 'kB' } } });
    // bundle.jupyter.kB accepts 8.37 (28 October 2026): from a 4.7 base, 8.37 is no regression.
    const accepted = compare(size(4.7), size(8.37), budgets);
    expect(accepted.ok).toBe(true);
    expect(accepted.lines[0]).toMatch(/against 8\.37 \(accepted: /);
    // Past the accepted value by more than the floor: a regression, and over the budget too.
    const past = compare(size(4.7), size(10.5), budgets);
    expect(past.ok).toBe(false);
    expect(past.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/bundle\.jupyter\.kB: 10\.5 kB regressed .* against 8\.37/),
      ]),
    );
    // A base already past the accepted value is the base.
    expect(compare(size(9), size(9.5), budgets).lines[0]).toMatch(/against 9$/);
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

  it('lists a figure only reported, without a budget, a gate or a regression', () => {
    const figures = (value: number) => ({
      figures: { 'scrollFling.maxFrameMs': { value, unit: 'ms' } },
    });
    const { ok, lines, failures } = compare(figures(33), figures(366), budgets);
    expect(failures).toEqual([]);
    expect(ok).toBe(true);
    expect(lines).toEqual(['scrollFling.maxFrameMs: 366 ms (reported)']);
    const wrongUnit = { figures: { 'scrollFling.maxFrameMs': { value: 33, unit: 's' } } };
    expect(compare(null, wrongUnit, budgets).failures[0]).toMatch(/measured in s, reported in ms/);
    const notANumber = { figures: { 'scrollFling.framesOver': { value: NaN, unit: 'frames' } } };
    expect(compare(null, notANumber, budgets).failures[0]).toMatch(/not a number/);
  });

  it('gates the fling on its p99, and lists no figure as both budgeted and reported', () => {
    const over = { figures: { 'scrollFling.p99FrameMs': { value: 33.3, unit: 'ms' } } };
    expect(compare(null, over, budgets).failures[0]).toMatch(/over its budget of 16\.7/);
    expect(budgets.budgets['dataSource.scrollFling.p99FrameMs'].max).toBe(16.7);
    const both = Object.keys(budgets.reported).filter((n) => n in budgets.budgets);
    expect(both).toEqual([]);
  });

  it('refuses a figure measured in another unit than its budget', () => {
    const current = { figures: { 'harness.noop.ms': { value: 0.1, unit: 's' } } };
    expect(compare(null, current, budgets).failures[0]).toMatch(/measured in s, budgeted in ms/);
  });

  it('refuses an empty result', () => {
    expect(compare(null, { figures: {} }, budgets).ok).toBe(false);
  });

  it('fails on a result with a 20 % regression injected into every figure, and passes the real one against itself', () => {
    const real = {
      figures: {
        'harness.noop.ms': { value: 0.5, unit: 'ms' },
        'recalc.full.ms': { value: 700, unit: 'ms' },
        'bundle.grid.kB': { value: 90, unit: 'kB' },
      },
    };
    const worse = inject(real, 0.2);
    expect(worse.figures['recalc.full.ms'].value).toBeCloseTo(840);
    expect(worse.injected).toBe(0.2);
    const { ok, failures } = compare(real, worse, budgets);
    expect(ok).toBe(false);
    expect(failures.map((f) => f.split(':')[0]).sort()).toEqual([
      'bundle.grid.kB',
      'harness.noop.ms',
      'recalc.full.ms',
    ]);
    expect(compare(real, real, budgets).ok).toBe(true);
    expect(() => inject(real, 0)).toThrow('inject takes a positive fraction');
  });
});
