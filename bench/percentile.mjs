/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** The p-th percentile (0–100) of `values`, nearest-rank. */
export function percentile(values, p) {
  if (values.length === 0) throw new Error('No value to take a percentile of.');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[rank];
}
