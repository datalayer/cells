/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { defineConfig } from 'vitest/config';

// Node by default: the core must run without a DOM. A test that needs one
// says `// @vitest-environment jsdom`. Two workers at most, so a test run
// stays light next to the other work on the machine.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts?(x)', 'bench/__tests__/**/*.test.ts'],
    pool: 'forks',
    // `global.gc` for the memory figures (bytes per cell).
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    maxWorkers: 2,
    minWorkers: 1,
    benchmark: {
      include: ['bench/node/**/*.bench.ts'],
    },
  },
});
