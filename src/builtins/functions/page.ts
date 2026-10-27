/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The functions page, `docs/functions.md`, written from the functions'
 * own metadata (`npm run functions-page`); a test fails when the page and
 * the functions differ.
 *
 * @module builtins/functions/page
 */

import type { FormulaFunction } from '../../points/index.js';

const CATEGORIES: Record<FormulaFunction['category'], string> = {
  math: 'Math',
  statistics: 'Statistics',
  logic: 'Logic',
  text: 'Text',
  lookup: 'Lookup and reference',
  date: 'Date and time',
  information: 'Information',
  other: 'Other',
};

function signature(f: FormulaFunction): string {
  const args = f.args.map((a) => {
    const name = a.repeating ? `${a.name}, …` : a.name;
    return a.optional ? `[${name}]` : name;
  });
  return `${f.name}(${args.join(', ')})`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|');

export function functionsPage(functions: readonly FormulaFunction[]): string {
  const out: string[] = [
    "<!-- Generated from the functions' metadata by `npm run functions-page`; do not edit. -->",
    '',
    '# Functions',
    '',
    `Cells ships ${functions.length} functions. Each is checked against what LibreOffice computes (\`tests/formula/golden.json\`, made by \`scripts/formula-golden.py\`), except where Excel answers otherwise, as the golden file says case by case. A plugin adds its own through the \`datalayer.cells.function\` contribution point.`,
    '',
  ];
  for (const [category, title] of Object.entries(CATEGORIES)) {
    const list = functions
      .filter((f) => f.category === category)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) continue;
    out.push(`## ${title}`, '', '| Function | What it does | Example |', '| --- | --- | --- |');
    for (const f of list) {
      const flags = f.volatile ? ' Recalculated on every change.' : '';
      out.push(
        `| \`${cell(signature(f))}\` | ${cell(f.description)}${flags} | \`${cell(f.examples[0])}\` |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}
