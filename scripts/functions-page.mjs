/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Write docs/functions.md from the built-in functions' metadata.
 *
 *     npm run functions-page
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { format, resolveConfig } from 'prettier';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const entry = `
import { FUNCTIONS } from './src/builtins/functions/index.ts';
import { functionsPage } from './src/builtins/functions/page.ts';
export default functionsPage(FUNCTIONS);
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const url = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`;
const target = fileURLToPath(new URL('../docs/functions.md', import.meta.url));
// Written as Prettier writes it, so the lint and the sync test agree.
const page = await format((await import(url)).default, {
  ...(await resolveConfig(target)),
  filepath: target,
});
mkdirSync(new URL('../docs', import.meta.url), { recursive: true });
writeFileSync(target, page);
console.log('wrote docs/functions.md');
