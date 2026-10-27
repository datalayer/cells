/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Run the benches and write `bench/results/<date>-<sha>.json`.
 *
 *     node scripts/bench.mjs              # Node benches (vitest bench)
 *     node scripts/bench.mjs --browser    # and the browser benches (system Chrome)
 *
 * A Node bench's name is its figure; its value is tinybench's p99 per
 * iteration, in ms. A browser bench returns its figures itself (p95 over at
 * least five runs). Benches run one at a time, never next to a build.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const browser = process.argv.includes('--browser');
const budgets = JSON.parse(readFileSync(join(ROOT, 'bench/budgets.json'), 'utf8')).budgets;

const figures = {};

const scratch = mkdtempSync(join(tmpdir(), 'cells-bench-'));
const out = join(scratch, 'node.json');
execFileSync('npx', ['vitest', 'bench', '--run', '--outputJson', out], {
  cwd: ROOT,
  stdio: 'inherit',
});
const report = JSON.parse(readFileSync(out, 'utf8'));
rmSync(scratch, { recursive: true, force: true });
for (const file of report.files) {
  for (const group of file.groups) {
    for (const b of group.benchmarks) {
      const budget = budgets[b.name];
      if (budget === undefined) {
        throw new Error(`The bench '${b.name}' names no figure of bench/budgets.json.`);
      }
      figures[b.name] = { value: b.p99, unit: budget.unit, runs: b.sampleCount };
    }
  }
}

if (browser) {
  const { launch } = await import('../bench/browser/trace.mjs');
  const benches = readdirSync(join(ROOT, 'bench/browser')).filter(
    (name) => name.endsWith('.mjs') && name !== 'trace.mjs',
  );
  const chrome = await launch();
  try {
    for (const name of benches.sort()) {
      const { run } = await import(join(ROOT, 'bench/browser', name));
      Object.assign(figures, await run(chrome));
    }
  } finally {
    await chrome.close();
  }
}

let sha = 'nogit';
try {
  sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
} catch {
  // A fresh repository with no commit yet.
}
const date = new Date().toISOString().slice(0, 10);
const result = {
  version: 1,
  sha,
  date,
  machine: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    node: process.version,
  },
  figures,
};
mkdirSync(join(ROOT, 'bench/results'), { recursive: true });
const path = join(ROOT, 'bench/results', `${date}-${sha}.json`);
writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${path} (${Object.keys(figures).length} figures)`);
