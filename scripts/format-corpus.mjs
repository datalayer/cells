/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Write the shared CellsWorkbook corpus (`tests/format/workbooks/*.json`):
 * a slice of each bench fixture, with sizes, a hidden column, a merge, a
 * frozen pane, a style and an error. The TypeScript and the Python loaders
 * both round-trip these files; a test keeps them in step with the fixtures.
 *
 *     node scripts/format-corpus.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES } from '../bench/fixtures/fixtures.ts';

const DIR = fileURLToPath(new URL('../tests/format/workbooks/', import.meta.url));

function workbookOf(f, rows) {
  const out = {};
  for (let r = 0; r < Math.min(rows, f.rows); r += 1) {
    for (let c = 0; c < f.cols; c += 1) {
      const v = f.cell(r, c);
      if (v === null) continue;
      const cell = typeof v === 'string' && v.startsWith('=') ? { f: v.slice(1) } : { v };
      (out[r] ??= { cells: {} }).cells[c] = r % 7 === 0 ? { ...cell, s: 1 } : cell;
    }
  }
  return {
    version: 1,
    sheets: [
      {
        id: 's1',
        name: f.name,
        rows: out,
        sizes: { rows: { 3: 40 }, cols: { 1: 160 } },
        hidden: { cols: [4] },
        merges: [{ top: 0, left: 8, bottom: 1, right: 9 }],
        frozen: { rows: 1, cols: 1 },
      },
      { id: 's2', name: 'Notes', rows: { 0: { cells: { 0: { v: { error: '#N/A' } } } } } },
    ],
    styles: [{}, { bold: true, fill: '#ffeeaa', format: '#,##0.00' }],
  };
}

mkdirSync(DIR, { recursive: true });
for (const f of Object.values(FIXTURES)) {
  const path = join(DIR, `${f.name}.json`);
  writeFileSync(path, JSON.stringify(workbookOf(f, Math.floor(2000 / f.cols))) + '\n');
  console.log(`wrote ${path}`);
}
