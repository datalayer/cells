/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The Docusaurus plugin: Datalayer Cells in a documentation site.
 *
 * A page shows a live sheet with the `<Cells>` theme component, from a
 * workbook written as data in a `.cells.json` file the page imports, or from
 * a `.cells.json` or `.csv` file the site serves:
 *
 * ```mdx
 * import Cells from '@theme/Cells';
 * import budget from '@site/cells/budget.cells.json';
 *
 * <Cells data={budget} height={240} />
 * <Cells src="/data/sales.csv" />
 * ```
 *
 * The plugin checks every `.cells.json` and `.csv` under `cellsDir` when the
 * site builds (and again when one changes under `docusaurus start`), with
 * the grid's own loader and parser, so a sheet that cannot be shown stops the
 * build rather than reaching a reader. It keeps the grid out of the server
 * bundle: sheets draw in the browser only.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  type CellsFileProblem,
  type CellsFileSummary,
  type CellsModules,
  checkCellsFile,
  describeProblems,
  fileKind,
} from './check.js';

export { checkCellsFile, describeProblems, fileKind } from './check.js';
export type { CellsFileCheck, CellsFileProblem, CellsFileSummary, CellsModules } from './check.js';

/** The plugin's name, under which the client reads its options. */
export const PLUGIN_NAME = 'docusaurus-plugin-cells';

/** The module the theme loads the grid from: the real one in the browser, nothing on the server. */
const CLIENT_MODULE = '@datalayer/cells-docusaurus/client';

export type CellsPluginOptions = {
  /** Where the site's cells files are, from the site's directory. `cells` when absent. */
  cellsDir?: string;
  /** The most cells a file may hold; no limit when absent. */
  maxCells?: number;
  /**
   * The primer-addons theme variant the sheets wear: `loop` (what datalayer.ai
   * wears) when absent, or `datalayer`, `spatial` and the others. The colour
   * mode follows the site's own switch.
   */
  theme?: string;
  /** Whether readers may edit the sheets (edits stay in the page); `false` when absent. */
  editable?: boolean;
  /** The grid's loader and parser, to check in this thread (tests); absent, a worker thread loads the site's. */
  modules?: CellsModules;
};

/**
 * The modules there must be one copy of in a page: the site's own. A grid
 * resolved from elsewhere in a workspace would otherwise bring its own React,
 * which is a broken-hooks error rather than a duplicated byte.
 */
const SHARED = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom/client',
];

/** Where `name` resolves from the site: an alias that pins every import of it there. */
const sharedAliases = (siteDir: string): Record<string, string> => {
  const fromSite = createRequire(path.join(siteDir, 'package.json'));
  const aliases: Record<string, string> = {};
  for (const name of SHARED) {
    try {
      // `name$` so that only the bare name is pinned, never `react-dom/…` by prefix.
      aliases[`${name}$`] = fromSite.resolve(name);
    } catch {
      // A module the site does not have: nothing to pin.
    }
  }
  return aliases;
};

/** What the client reads (`usePluginData`). */
export type CellsGlobalData = {
  theme: string;
  editable: boolean;
};

export const DEFAULT_THEME = 'loop';

type LoadContext = { siteDir: string };

type ContentLoadedArgs = {
  content: unknown;
  actions: { setGlobalData: (data: CellsGlobalData) => void };
};

/** Every cells file under `dir`, recursively; none when it does not exist. */
export const cellsFiles = async (dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && fileKind(entry.name) !== undefined)
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
};

/** The check in a worker thread, with Node's own ES-module loader (see `worker.ts`). */
const checkInWorker = (
  here: string,
  files: readonly { file: string; text: string }[],
  maxCells: number | undefined,
): Promise<{ problems: CellsFileProblem[]; summary?: CellsFileSummary }[]> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(path.join(here, 'worker.js'), { workerData: { files, maxCells } });
    worker.once('message', (result) => {
      resolve(result as { problems: CellsFileProblem[]; summary?: CellsFileSummary }[]);
      void worker.terminate();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`${PLUGIN_NAME}: the check stopped with code ${code}`));
    });
  });

export default function cellsPlugin(context: LoadContext, options: CellsPluginOptions = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cellsDir = path.resolve(context.siteDir, options.cellsDir ?? 'cells');
  const theme = options.theme ?? DEFAULT_THEME;
  const editable = options.editable ?? false;
  if (options.maxCells !== undefined && !(options.maxCells >= 1))
    throw new Error(`${PLUGIN_NAME}: maxCells must be at least 1`);

  return {
    name: PLUGIN_NAME,

    getThemePath() {
      return path.join(here, 'theme');
    },

    getPathsToWatch() {
      return [path.join(cellsDir, '**', '*.cells.json'), path.join(cellsDir, '**', '*.csv')];
    },

    async loadContent() {
      const paths = await cellsFiles(cellsDir);
      const files = await Promise.all(
        paths.map(async (file) => ({
          file: path.relative(context.siteDir, file),
          text: await readFile(file, 'utf8'),
        })),
      );
      const checked =
        options.modules !== undefined
          ? files.map(({ file, text }) =>
              checkCellsFile(file, text, options.modules!, { maxCells: options.maxCells }),
            )
          : await checkInWorker(here, files, options.maxCells);
      const problems: CellsFileProblem[] = checked.flatMap((c) => c.problems);
      if (problems.length > 0)
        throw new Error(
          `${PLUGIN_NAME}: sheets that cannot be shown:\n${describeProblems(problems)}`,
        );
      const cells = checked.reduce((n, c) => n + (c.summary?.cells ?? 0), 0);
      return { files: files.length, cells };
    },

    async contentLoaded({ actions }: ContentLoadedArgs) {
      actions.setGlobalData({ theme, editable });
    },

    configureWebpack(_config: unknown, isServer: boolean) {
      return {
        resolve: {
          alias: {
            ...sharedAliases(context.siteDir),
            // The grid is React, canvas and Primer: there is nothing for a prerender
            // to gain by compiling it, and the theme draws it only in the browser.
            [CLIENT_MODULE]: isServer ? false : path.join(here, 'client', 'CellsClient.js'),
          },
        },
        module: {
          rules: [
            {
              // Packages compiled by `tsc` import their siblings without a
              // file extension, which webpack refuses in an ES module.
              test: /\.m?js$/,
              resolve: { fullySpecified: false },
            },
          ],
        },
      };
    },
  };
}
