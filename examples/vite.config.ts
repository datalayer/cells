/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The examples run on the package's source: no library build is needed.
export const PORT = 3077;

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@datalayer\/cells$/,
        replacement: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      },
      {
        find: /^@datalayer\/cells\/chrome$/,
        replacement: fileURLToPath(new URL('../src/chrome/index.ts', import.meta.url)),
      },
      {
        find: /^@datalayer\/cells\/csv$/,
        replacement: fileURLToPath(new URL('../src/csv/index.ts', import.meta.url)),
      },
      {
        find: /^@datalayer\/cells\/xlsx$/,
        replacement: fileURLToPath(new URL('../src/xlsx/index.ts', import.meta.url)),
      },
      {
        find: /^@datalayer\/cells\/charts$/,
        replacement: fileURLToPath(new URL('../src/charts/index.ts', import.meta.url)),
      },
    ],
  },
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  build: {
    // Absolute: the dependency scan resolves the inputs from where the server
    // was started, not from the root (`make examples` starts it in the package).
    rollupOptions: {
      input: {
        index: page('index.html'),
        e2e: page('e2e.html'),
        bench: page('bench.html'),
      },
    },
  },
});
