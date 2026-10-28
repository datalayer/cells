/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Bundle sizes of the budgets: each entry of the built `lib/` bundled with
 * esbuild (minified, peers external), gzipped, and checked against
 * bench/budgets.json. Prints the figures as a result file on stdout when
 * `--json` is given. Reads `lib/` as the build left it; never builds.
 */

import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const budgets = JSON.parse(readFileSync(join(ROOT, 'bench/budgets.json'), 'utf8')).budgets;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const external = [
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}).map((name) => `${name}/*`),
  'react/jsx-runtime',
];

// `./charts` twice: with its peers external (what the package adds), and with
// the ECharts modules its types register bundled (what a host that has no
// ECharts downloads); a full `import 'echarts'` would fail the second (§3.12).
const ECHARTS = ['echarts', 'echarts/*', 'echarts-for-react', 'echarts-for-react/*'];
const ENTRIES = {
  'bundle.grid.kB': { entry: 'lib/index.js', external, noEcharts: true },
  'bundle.xlsx.kB': { entry: 'lib/xlsx/index.js', external, noEcharts: true },
  'bundle.chrome.kB': { entry: 'lib/chrome/index.js', external, noEcharts: true },
  'bundle.charts.kB': { entry: 'lib/charts/index.js', external },
  'bundle.chartsECharts.kB': {
    entry: 'lib/charts/index.js',
    external: external.filter((name) => !ECHARTS.includes(name)),
  },
};

const figures = {};
let failed = false;
for (const [figure, { entry, external: ext, noEcharts }] of Object.entries(ENTRIES)) {
  const path = join(ROOT, entry);
  if (!existsSync(path)) {
    console.error(`${entry} does not exist: the library is not built.`);
    process.exit(1);
  }
  const result = await build({
    entryPoints: [path],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external: ext,
    metafile: true,
    logLevel: 'silent',
  });
  if (noEcharts) {
    const inputs = Object.keys(result.metafile.inputs).filter(
      (p) =>
        /(^|\/)echarts(-for-react)?\//.test(p) ||
        /(^|\/)src\/charts\//.test(p) ||
        /(^|\/)lib\/charts\//.test(p),
    );
    if (inputs.length > 0) {
      console.error(
        `${figure}: the metafile of ${entry} has an ECharts input: ${inputs.slice(0, 3).join(', ')}`,
      );
      failed = true;
    }
  }
  const bytes = gzipSync(result.outputFiles[0].contents).length;
  const kB = Math.round((bytes / 1024) * 100) / 100;
  figures[figure] = { value: kB, unit: 'kB' };
  const max = budgets[figure].max;
  const over = kB > max;
  failed ||= over;
  console.error(`${figure}: ${kB} kB min+gzip (budget ${max})${over ? '  OVER BUDGET' : ''}`);
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ version: 1, figures }, null, 2));
process.exit(failed ? 1 : 0);
