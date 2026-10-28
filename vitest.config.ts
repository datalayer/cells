/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// Node by default: the core must run without a DOM. A test that needs one
// says `// @vitest-environment jsdom`. Two workers at most, so a test run
// stays light next to the other work on the machine.
export default defineConfig({
  // A test may mount an example page: its `@datalayer/cells` imports resolve to the source.
  resolve: {
    alias: [
      { find: /^@datalayer\/cells$/, replacement: src('index.ts') },
      { find: /^@datalayer\/cells\/csv$/, replacement: src('csv/index.ts') },
      { find: /^@datalayer\/cells\/chrome$/, replacement: src('chrome/index.ts') },
      { find: /^@datalayer\/cells\/xlsx$/, replacement: src('xlsx/index.ts') },
      { find: /^@datalayer\/cells\/charts$/, replacement: src('charts/index.ts') },
      { find: /^@datalayer\/cells\/collab$/, replacement: src('collab/index.ts') },
      { find: /^@datalayer\/cells\/jupyter$/, replacement: src('jupyter/index.tsx') },
    ],
  },
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
