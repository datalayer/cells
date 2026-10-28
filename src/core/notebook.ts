/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A workbook's code cells as a notebook (§3.13, C11-07): one code cell per
 * code cell, in reading order, with its outputs and execution count, the
 * honest round trip of code out of a sheet. Each notebook cell says which
 * sheet cell it was in its metadata (`cells: { sheet, ref }`), and a
 * markdown cell at the top names the workbook's sheets.
 *
 * @module core/notebook
 */

import { codeCells, codeRef, type CodeOutput } from './code.js';
import type { Workbook } from './workbook.js';

/** A notebook (nbformat 4), as far as the export writes it. */
export interface Notebook {
  readonly nbformat: 4;
  readonly nbformat_minor: 5;
  readonly metadata: {
    readonly kernelspec: {
      readonly name: string;
      readonly display_name: string;
      readonly language: string;
    };
    readonly language_info: { readonly name: string };
  };
  readonly cells: readonly NotebookCell[];
}

/** A cell of the exported notebook. */
export interface NotebookCell {
  readonly id: string;
  readonly cell_type: 'code' | 'markdown';
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly outputs?: readonly CodeOutput[];
  readonly execution_count?: number | null;
}

/** The notebook of a workbook's code cells: every sheet's, in reading order, or one sheet's. */
export function toNotebook(workbook: Workbook, sheet?: string): Notebook {
  const sheets = sheet === undefined ? workbook.sheets : [workbook.sheet(sheet)];
  const cells: NotebookCell[] = [
    {
      id: 'cells-title',
      cell_type: 'markdown',
      metadata: {},
      source: `# Code cells of ${sheets.map((s) => s.name).join(', ')}\n\nExported from a Cells workbook: each cell below is a code cell of the sheet named in its metadata, with the outputs of its last run. In the sheet, \`cells["A1:B10"]\` reads a range.`,
    },
  ];
  for (const s of sheets) {
    for (const c of codeCells(s)) {
      const ref = codeRef(c.row, c.col);
      cells.push({
        id: `${s.id}-${ref}`,
        cell_type: 'code',
        metadata: {
          cells: {
            sheet: s.name,
            ref,
            run: c.code.run,
            ...(c.code.lastRun !== undefined ? { lastRun: c.code.lastRun } : {}),
          },
        },
        source: c.code.source,
        outputs: c.code.outputs,
        execution_count: c.code.executionCount ?? null,
      });
    }
  }
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells,
  };
}

/** The notebook as `.ipynb` text. */
export function notebookText(workbook: Workbook, sheet?: string): string {
  return `${JSON.stringify(toNotebook(workbook, sheet), null, 1)}\n`;
}
