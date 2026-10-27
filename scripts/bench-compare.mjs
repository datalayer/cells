/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Compare a bench result with a base result and with the budgets; exit 1 on
 * a figure over budget or regressed beyond the threshold.
 *
 *     node scripts/bench-compare.mjs <current.json> [<base.json>] [--threshold 0.15]
 */

import { readFileSync } from 'node:fs';
import { compare } from '../bench/compare.mjs';

const args = process.argv.slice(2);
let threshold = 0.15;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--threshold') {
    threshold = Number(args[i + 1]);
    i += 1;
    if (!(threshold > 0)) {
      console.error('--threshold takes a positive fraction, such as 0.15');
      process.exit(2);
    }
  } else {
    files.push(args[i]);
  }
}
if (files.length < 1 || files.length > 2) {
  console.error(
    'usage: node scripts/bench-compare.mjs <current.json> [<base.json>] [--threshold 0.15]',
  );
  process.exit(2);
}
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const budgets = read(new URL('../bench/budgets.json', import.meta.url));
const current = read(files[0]);
const base = files[1] ? read(files[1]) : null;
const { ok, lines, failures } = compare(base, current, budgets, { threshold });
for (const line of lines) console.log(line);
if (!ok) {
  console.error(`\n${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`\n${lines.length} figure(s) within budget${base ? ' and without regression' : ''}`);
