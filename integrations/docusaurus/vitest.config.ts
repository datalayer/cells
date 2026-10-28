/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const lib = (path: string) => fileURLToPath(new URL(`../../lib/${path}`, import.meta.url));

// The checks run in Node against the grid as this repository builds it (lib/).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@datalayer\/cells\/core$/, replacement: lib('core/index.js') },
      { find: /^@datalayer\/cells\/csv$/, replacement: lib('csv/index.js') },
      { find: /^@datalayer\/cells$/, replacement: lib('index.js') },
    ],
  },
  test: { environment: 'node', include: ['src/__tests__/**/*.test.ts'] },
});
