/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Every source file starts with the Datalayer header, in the form decks uses,
 * with this repository's licence line. Fails naming each file that does not.
 *
 *     node scripts/check-headers.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LICENCE_LINE = 'MIT License';
const COPYRIGHT = 'Copyright (c) 2022-2026 Datalayer, Inc.';

const BLOCK = `/*\n * ${COPYRIGHT}\n *\n * ${LICENCE_LINE}\n */\n`;
const HASH = `# ${COPYRIGHT}\n#\n# ${LICENCE_LINE}\n`;

const ROOTS = [
  'src',
  'scripts',
  'bench',
  'e2e',
  'examples',
  'dev',
  'style',
  '.github',
  'datalayer_cells',
  'tests',
];
const TOP_FILES = [
  'vitest.config.ts',
  'vitest.react18.config.ts',
  'playwright.config.ts',
  'Makefile',
  'pyproject.toml',
];
const SKIP_DIRS = new Set(['node_modules', 'lib', 'results', 'dist', '__pycache__']);

function expected(path) {
  const ext = extname(path);
  if (['.ts', '.tsx', '.js', '.mjs', '.css'].includes(ext)) return BLOCK;
  if (['.py', '.yaml', '.yml', '.toml'].includes(ext) || path.endsWith('Makefile')) return HASH;
  return null;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(path);
    } else {
      yield path;
    }
  }
}

const files = [];
for (const root of ROOTS) {
  try {
    statSync(join(ROOT, root));
  } catch {
    continue;
  }
  files.push(...walk(join(ROOT, root)));
}
for (const name of TOP_FILES) {
  try {
    statSync(join(ROOT, name));
    files.push(join(ROOT, name));
  } catch {
    // Not every top-level file exists yet.
  }
}

const missing = [];
let checked = 0;
for (const path of files) {
  const header = expected(path);
  if (header === null) continue;
  checked += 1;
  let text = readFileSync(path, 'utf8');
  if (text.startsWith('#!')) text = text.slice(text.indexOf('\n') + 1);
  if (!text.startsWith(header)) missing.push(relative(ROOT, path));
}

if (missing.length > 0) {
  console.error(`${missing.length} file(s) lack the header:\n  ${missing.join('\n  ')}`);
  console.error(`\nExpected, for TypeScript, JavaScript and CSS:\n${BLOCK}`);
  process.exit(1);
}
console.log(`headers: ${checked} files checked, all carry the header`);
