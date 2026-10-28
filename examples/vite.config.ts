/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// The examples run on the package's source: no library build is needed.
export const PORT = 3077;

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

/**
 * JupyterLab and jupyter-react (the code cells page) import text the way webpack
 * reads it: a `?text` query on the JupyterLite service worker, and `.raw.css`
 * stylesheets as strings. Vite's spelling of both is `?raw`.
 */
function textQuery(): Plugin {
  return {
    name: 'cells-text-query',
    enforce: 'pre',
    async resolveId(source, importer) {
      const raw = source.includes('?text')
        ? source.replace('?text', '?raw')
        : source.endsWith('.raw.css')
          ? `${source}?raw`
          : undefined;
      if (raw === undefined) return null;
      const resolved = await this.resolve(raw, importer, { skipSelf: true });
      return resolved?.id ?? null;
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // loro-crdt (through ./collab and lexical-loro) is WebAssembly: the dev server needs
  // these two to load it; a production build does not.
  plugins: [react(), wasm(), textQuery()],
  optimizeDeps: { exclude: ['loro-crdt', '@datalayer/lexical-loro'] },
  // JupyterLab's packages (through jupyter-react, on the code cells page) read `global`.
  // As jupyter-react's own Vite configs: JupyterLab's packages and the ipywidgets
  // embed read webpack's public path, which Vite does not define (the code editor
  // overlay threw "__webpack_public_path__ is not defined" on a double-click).
  define: { global: 'globalThis', __webpack_public_path__: '""', 'process.env': {} },
  worker: { format: 'es' },
  // JupyterLab's wheels, fetched by the browser kernel, travel as assets.
  assetsInclude: ['**/*.whl'],
  resolve: {
    alias: [
      // JupyterLab's stylesheets import each other with webpack's `~` prefix.
      { find: /^~(.*)$/, replacement: '$1' },
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
        find: /^@datalayer\/cells\/collab$/,
        replacement: fileURLToPath(new URL('../src/collab/index.ts', import.meta.url)),
      },
      {
        find: /^@datalayer\/cells\/charts$/,
        replacement: fileURLToPath(new URL('../src/charts/index.ts', import.meta.url)),
      },
      {
        find: /^@datalayer\/cells\/jupyter$/,
        replacement: fileURLToPath(new URL('../src/jupyter/index.tsx', import.meta.url)),
      },
    ],
  },
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  build: {
    // @jupyter-widgets/controls (through jupyter-react's widget manager) mixes
    // `import` with a bare `require('../package.json')`: the build must
    // transform such modules, or the Code cells page throws `require is not
    // defined` at load in production (the dev server pre-bundles it).
    commonjsOptions: { transformMixedEsModules: true },
    // loro-crdt's WebAssembly loads with a top-level await: the modern target carries it as is
    // (vite-plugin-top-level-await's transform refused the production build's default target).
    target: 'esnext',
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
