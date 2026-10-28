/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The React tests again, against React 18.3: JupyterLab extensions ship
// React 18, and the component must run there (G1). React 18 is installed
// under the aliases `react-18` and `react-dom-18`. They are linked here as
// `react` and `react-dom` in a directory of their own, and resolved with
// symlinks preserved, so react-dom 18's own `require('react')` reaches
// React 18 rather than the React 19 beside it.
const root = dirname(fileURLToPath(import.meta.url));
const shadow = join(root, 'node_modules', '.react18', 'node_modules');
const resolve = createRequire(import.meta.url).resolve;
const packageDir = (name: string) => dirname(realpathSync(resolve(`${name}/package.json`)));

rmSync(shadow, { recursive: true, force: true });
mkdirSync(shadow, { recursive: true });
symlinkSync(packageDir('react-18'), join(shadow, 'react'));
symlinkSync(packageDir('react-dom-18'), join(shadow, 'react-dom'));
if (!existsSync(join(shadow, 'react', 'index.js')))
  throw new Error('React 18 is not installed (react-18).');

const at = (path: string) => join(shadow, path);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/react/**/__tests__/**/*.test.ts?(x)'],
    // The context menu is Primer's Overlay, whose compiled output calls `react-compiler-runtime`;
    // that package reaches React through a CommonJS require the aliases cannot redirect, so in
    // this harness it meets the hoisted React 19 beside the aliased 18 and fails. Primer itself
    // runs on React 18 (its peer range); the menu under React 18 is checked in a React 18 host
    // (JupyterLab), not here.
    exclude: ['**/node_modules/**', 'src/react/__tests__/menu.test.tsx'],
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--preserve-symlinks'] } },
    maxWorkers: 2,
    minWorkers: 1,
    server: { deps: { inline: [/\.react18/, /@datalayer\/reactor/] } },
  },
  resolve: {
    preserveSymlinks: true,
    alias: [
      { find: /^react-dom\/client$/, replacement: at('react-dom/client.js') },
      { find: /^react-dom$/, replacement: at('react-dom/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: at('react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: at('react/jsx-dev-runtime.js') },
      { find: /^react$/, replacement: at('react/index.js') },
    ],
  },
});
