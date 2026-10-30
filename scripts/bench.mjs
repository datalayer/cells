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
 *     node scripts/bench.mjs --attempts 3 # a Node figure over budget is measured again
 *
 * A Node bench's name is its figure; its value is tinybench's p99 per
 * iteration, in ms. A browser bench returns its figures itself (p95 over at
 * least five runs). Benches run one at a time, never next to a build.
 *
 * With `--attempts n`, the Node benches run again while a figure is over its
 * budget, up to n runs in all, and each figure keeps its best run (CI passes
 * 3: a shared runner's busy neighbour slows one run, a regression every run).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { best, overBudget } from '../bench/best.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const browser = process.argv.includes('--browser');
const attemptsAt = process.argv.indexOf('--attempts');
const attempts = attemptsAt === -1 ? 1 : Number(process.argv[attemptsAt + 1]);
if (!Number.isInteger(attempts) || attempts < 1) {
  console.error('--attempts takes a whole number of runs, 1 or more');
  process.exit(2);
}
const budgets = JSON.parse(readFileSync(join(ROOT, 'bench/budgets.json'), 'utf8')).budgets;

/** One run of the Node benches: their figures, each a bench's p99. */
function runNode() {
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
  return figures;
}

let figures = best({}, runNode());
for (let attempt = 2; attempt <= attempts; attempt += 1) {
  const over = overBudget(figures, { budgets });
  if (over.length === 0) break;
  console.log(
    `over budget after ${attempt - 1} run(s): ${over.join(', ')}; run ${attempt} of ${attempts}`,
  );
  figures = best(figures, runNode());
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
// A production build's figures are their own file: they do not stand for the budgets' dev run.
const production = browser && process.env.CELLS_BENCH_BUILD === 'production';
const result = {
  version: 1,
  sha,
  date,
  ...(production ? { build: 'production' } : {}),
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
const path = join(ROOT, 'bench/results', `${date}-${sha}${production ? '-production' : ''}.json`);
writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${path} (${Object.keys(figures).length} figures)`);
