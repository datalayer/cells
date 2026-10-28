/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Write a copy of a bench result with every figure regressed by a fraction,
 * for the CI check that the regression gate fails on it.
 *
 *     node scripts/bench-inject.mjs <result.json> <out.json> [--fraction 0.2]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { inject } from '../bench/inject.mjs';

const args = process.argv.slice(2);
let fraction = 0.2;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--fraction') {
    fraction = Number(args[i + 1]);
    i += 1;
  } else files.push(args[i]);
}
if (files.length !== 2 || !(fraction > 0)) {
  console.error('usage: node scripts/bench-inject.mjs <result.json> <out.json> [--fraction 0.2]');
  process.exit(2);
}
const result = JSON.parse(readFileSync(files[0], 'utf8'));
writeFileSync(files[1], JSON.stringify(inject(result, fraction), null, 2) + '\n');
console.log(`wrote ${files[1]}: every figure of ${files[0]} regressed by ${fraction * 100} %`);
