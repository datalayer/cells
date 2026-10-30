/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The figures of a fling, from its frame times (rAF deltas, ms): the p99 frame,
 * which the budget reads, the frames over budget, and the longest frame, both
 * only reported (§4, the user's decision of 30 October 2026).
 */

import { percentile } from './percentile.mjs';

/** One frame on time at 60 Hz, ms: the budget of the fling's p99. */
const FRAME_MS = 16.7;

/**
 * rAF's timestamps are coarsened, so a frame on time reads 16.6 to 16.8 ms and
 * the longest of 600 reads over 16.7. A frame within this margin is on time; a
 * frame missed is at least 33 ms, far past it.
 */
const JITTER_MS = 0.5;

/**
 * @param {string} prefix `scrollFling` or `dataSource.scrollFling`
 * @param {number[]} deltas
 * @returns {Record<string, { value: number, unit: string, runs: number }>}
 */
export function flingFigures(prefix, deltas) {
  if (deltas.length === 0) throw new Error('A fling with no frame has no figures.');
  const frames = deltas.map((d) => (d <= FRAME_MS + JITTER_MS ? Math.min(d, FRAME_MS) : d));
  const runs = deltas.length;
  return {
    [`${prefix}.p99FrameMs`]: { value: round(percentile(frames, 99)), unit: 'ms', runs },
    [`${prefix}.framesOver`]: {
      value: frames.filter((f) => f > FRAME_MS).length,
      unit: 'frames',
      runs,
    },
    [`${prefix}.maxFrameMs`]: { value: round(Math.max(...deltas)), unit: 'ms', runs },
  };
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
