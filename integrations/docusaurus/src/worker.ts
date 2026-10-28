/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The check, in a worker thread of its own. Docusaurus loads a plugin
 * through a CommonJS-style loader that cannot follow the `import`-only
 * exports of the ES-module packages the grid depends on; a worker thread
 * loads this file with Node's own ES-module loader, where `@datalayer/cells`
 * and its dependencies resolve as the site installed them.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { validateWorkbook } from '@datalayer/cells/core';
import { parseCsvText } from '@datalayer/cells/csv';
import { checkCellsFile } from './check.js';

export type CheckRequest = {
  files: readonly { file: string; text: string }[];
  maxCells?: number;
};

const { files, maxCells } = workerData as CheckRequest;
parentPort!.postMessage(
  files.map(({ file, text }) =>
    checkCellsFile(file, text, { validateWorkbook, parseCsvText }, { maxCells }),
  ),
);
