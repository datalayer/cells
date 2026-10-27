/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The built `lib/core` loads in plain Node, with no bundler, no React and no
 * DOM: what lets the model run on a server and in a worker. Run after
 * `npm run build`.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../lib/core/index.js', import.meta.url));
if (!existsSync(entry)) {
  console.error(`${entry} does not exist: run \`npm run build\` first.`);
  process.exit(1);
}
for (const name of ['window', 'document']) {
  if (name in globalThis) {
    console.error(`globalThis.${name} exists before the import; this check needs a bare Node.`);
    process.exit(1);
  }
}
const core = await import(entry);
console.log(`lib/core loads in plain Node: ${Object.keys(core).length} exports`);
