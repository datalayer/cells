/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

export interface Figure {
  value: number;
  unit: string;
  runs?: number;
}

export interface BenchResult {
  figures: Record<string, Figure>;
}

export interface Budgets {
  budgets: Record<string, { max: number; unit: string }>;
}

export const SIZE_FLOOR_KB: number;

export function compare(
  base: BenchResult | null,
  current: BenchResult,
  budgets: Budgets,
  options?: { threshold?: number },
): { ok: boolean; lines: string[]; failures: string[] };
