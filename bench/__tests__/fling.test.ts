/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { flingFigures } from '../fling.mjs';

/** `n` frames on a 60 Hz display, with rAF's timer jitter, then the frames given. */
const frames = (n: number, ...rest: number[]) => [
  ...Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 16.6 : 16.8)),
  ...rest,
];

describe('the fling figures', () => {
  it('counts a display frame with its timer jitter as on time', () => {
    const f = flingFigures('scrollFling', frames(600));
    expect(f['scrollFling.p99FrameMs'].value).toBe(16.7);
    expect(f['scrollFling.framesOver'].value).toBe(0);
    expect(f['scrollFling.maxFrameMs'].value).toBe(16.8);
  });

  it('keeps one long frame in 600 out of the p99, and in the count and the longest frame', () => {
    const f = flingFigures('dataSource.scrollFling', frames(599, 366.6));
    expect(f['dataSource.scrollFling.p99FrameMs']).toEqual({
      value: 16.7,
      unit: 'ms',
      runs: 600,
    });
    expect(f['dataSource.scrollFling.framesOver']).toEqual({
      value: 1,
      unit: 'frames',
      runs: 600,
    });
    expect(f['dataSource.scrollFling.maxFrameMs'].value).toBe(366.6);
  });

  it('reads a run of long frames in the p99', () => {
    const f = flingFigures('scrollFling', frames(580, ...Array<number>(20).fill(33.3)));
    expect(f['scrollFling.p99FrameMs'].value).toBe(33.3);
    expect(f['scrollFling.framesOver'].value).toBe(20);
  });

  it('refuses a fling with no frame', () => {
    expect(() => flingFigures('scrollFling', [])).toThrow(/no frame/);
  });
});
