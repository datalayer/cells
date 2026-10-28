/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

export function overBudget(
  figures: Record<string, { value: number }>,
  budgets: { budgets: Record<string, { max: number }> },
): string[];

export function best(
  sofar: Record<string, { value: number; unit: string; attempts?: number }>,
  attempt: Record<string, { value: number; unit: string }>,
): Record<string, { value: number; unit: string; attempts: number }>;
