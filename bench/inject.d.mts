/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import type { BenchResult } from './compare.mjs';

export function inject<T extends BenchResult>(
  result: T,
  fraction: number,
): T & { injected: number };
