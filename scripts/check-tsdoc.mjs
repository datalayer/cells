/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Every public export of every entry point carries a TSDoc comment: a type,
 * a function, a class, a constant or a component with nothing said about it
 * fails `npm run lint`, naming the export and its file. The API page,
 * docs/api.md, lists every export of every entry with its comment's first
 * sentence and a link to the file declaring it; it is written from the same walk,
 * and the check fails when the page in the repository is not what the walk
 * writes.
 *
 *     node scripts/check-tsdoc.mjs           # check the comments and the page
 *     node scripts/check-tsdoc.mjs --write   # rewrite docs/api.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRIES = [
  'src/index.ts',
  'src/core/index.ts',
  'src/csv/index.ts',
  'src/xlsx/index.ts',
  'src/collab/index.ts',
  'src/chrome/index.ts',
  'src/charts/index.ts',
  'src/plugin/index.ts',
  'src/jupyter/index.tsx',
];

const config = ts.getParsedCommandLineOfConfigFile(
  path.join(ROOT, 'tsconfig.json'),
  { noEmit: true },
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  },
);
const program = ts.createProgram(
  ENTRIES.map((e) => path.join(ROOT, e)),
  config.options,
);
const checker = program.getTypeChecker();

/** The exports of an entry, each resolved to what it names, with the file and line it is declared at. */
function exportsOf(entry) {
  const sf = program.getSourceFile(path.join(ROOT, entry));
  const mod = checker.getSymbolAtLocation(sf);
  if (mod === undefined) throw new Error(`${entry}: no module symbol.`);
  const out = [];
  for (const exported of checker.getExportsOfModule(mod)) {
    let symbol = exported;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol.declarations?.[0];
    if (decl === undefined) continue;
    const comment = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
    const documented = comment !== '' || symbol.getJsDocTags(checker).length > 0;
    const file = path.relative(ROOT, decl.getSourceFile().fileName);
    const { line } = decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart());
    const kind =
      symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)
        ? 'type'
        : symbol.flags & ts.SymbolFlags.Class
          ? 'class'
          : symbol.flags & ts.SymbolFlags.Function
            ? 'function'
            : 'const';
    out.push({ name: exported.name, file, line: line + 1, documented, comment, kind });
  }
  return out;
}

const missing = new Map();
let total = 0;
const byEntry = new Map();
for (const entry of ENTRIES) {
  const list = exportsOf(entry).sort((a, b) => a.name.localeCompare(b.name));
  byEntry.set(entry, list);
  for (const e of list) {
    total += 1;
    if (e.documented) continue;
    const key = `${e.file}:${e.line} ${e.name}`;
    if (!missing.has(key)) missing.set(key, entry);
  }
}
if (missing.size > 0) {
  console.error(`${missing.size} public export(s) carry no TSDoc comment:`);
  for (const key of [...missing.keys()].sort()) console.error(`  ${key}`);
  process.exit(1);
}

// ------------------------------------------------------------------ the API page

const IMPORTS = {
  'src/index.ts': '@datalayer/cells',
  'src/core/index.ts': '@datalayer/cells/core',
  'src/csv/index.ts': '@datalayer/cells/csv',
  'src/xlsx/index.ts': '@datalayer/cells/xlsx',
  'src/collab/index.ts': '@datalayer/cells/collab',
  'src/chrome/index.ts': '@datalayer/cells/chrome',
  'src/charts/index.ts': '@datalayer/cells/charts',
  'src/plugin/index.ts': '@datalayer/cells/plugin',
  'src/jupyter/index.tsx': '@datalayer/cells/jupyter',
};
const firstSentence = (text) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.+?\.)(\s|$)/);
  return (m ? m[1] : flat).replace(/\|/g, '\\|');
};
const parts = [
  '# API',
  '',
  'Every public export of every entry point of `@datalayer/cells`, with the first sentence of its TSDoc comment and a link to the file that declares it. `@datalayer/cells` re-exports everything of `./core`, so a React host imports from one place; `./core` is for code that must not reach React. This page is written by `node scripts/check-tsdoc.mjs --write` and checked by `npm run lint`.',
  '',
  'See also: [the plugin guide](plugins.md), [the keyboard](keyboard.md), [the file format](format.md), [the functions](functions.md).',
];
const core = new Set(byEntry.get('src/core/index.ts').map((e) => e.name));
for (const [entry, list] of byEntry) {
  const shown = entry === 'src/index.ts' ? list.filter((e) => !core.has(e.name)) : list;
  parts.push('', `## \`${IMPORTS[entry]}\``, '');
  if (entry === 'src/index.ts') parts.push('Besides everything of `@datalayer/cells/core`:', '');
  parts.push('| Export | Kind | What it is |', '| --- | --- | --- |');
  for (const e of shown)
    parts.push(`| [\`${e.name}\`](../${e.file}) | ${e.kind} | ${firstSentence(e.comment)} |`);
}
const page = await format(parts.join('\n') + '\n', {
  ...((await resolveConfig(path.join(ROOT, 'docs/api.md'))) ?? {}),
  filepath: path.join(ROOT, 'docs/api.md'),
});
const pagePath = path.join(ROOT, 'docs/api.md');
if (process.argv.includes('--write')) {
  writeFileSync(pagePath, page);
  console.log(`wrote docs/api.md (${total} exports)`);
} else {
  let current = '';
  try {
    current = readFileSync(pagePath, 'utf8');
  } catch {
    // no page yet
  }
  if (current !== page) {
    console.error(
      'docs/api.md is not what the exports say: run node scripts/check-tsdoc.mjs --write',
    );
    process.exit(1);
  }
}
console.log(`tsdoc: ${total} public exports of ${ENTRIES.length} entry points, all documented`);
