/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The code cell commands (§3.13): make the active cell a code cell, run it
 * (Shift+Enter on a code cell), run every code cell of the sheet, interrupt.
 * Running needs a kernel (`datalayer.cells.kernel`, which `./jupyter`
 * contributes); without one a run says *No kernel*.
 *
 * @module builtins/code
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { codeCell } from '../core/code.js';
import { codeRunner } from '../core/codeRun.js';
import { notebookText } from '../core/notebook.js';
import type { CellsModel } from '../core/model.js';
import { CellsExporters, CellsMenuItems } from '../points/index.js';
import { type CellsCommand, type CellsCommandArgument, gridKeysDescription } from './editing.js';
import { cellsArgument, currentCellsCommandTarget } from './target.js';

/** The name of `CellsCodePlugin`. */
export const CELLS_CODE_PLUGIN = '@datalayer/cells-code';

/** Whether the grid a command would act on has a code cell active (with no grid, the run itself says). */
function onCodeCell(): boolean {
  const t = currentCellsCommandTarget();
  if (t === undefined) return true;
  const { sheet, active } = t.model.selection;
  return t.model.code(sheet, active.row, active.col) !== undefined;
}

function command(
  id: string,
  name: string,
  run: (a: CellsCommandArgument) => unknown,
  extra: Partial<CellsCommand> = {},
): CellsCommand {
  return {
    id: `cells.code.${id}`,
    name,
    category: 'Cells',
    ...extra,
    execute: (argument: CellsCommandArgument) => run(cellsArgument(`cells.code.${id}`, argument)),
  };
}

/** The code cell commands, as Reactor commands. */
export const CODE_COMMANDS: readonly CellsCommand[] = [
  command(
    'insert',
    'Make the cell a code cell',
    ({ model: m }) => {
      const { sheet, active } = m.selection;
      if (m.code(sheet, active.row, active.col) !== undefined) return;
      const result = m.dispatch({
        type: 'SET_CODE',
        sheet,
        row: active.row,
        col: active.col,
        code: codeCell(''),
      });
      if (!result.ok) throw new Error(result.refusals.map((r) => r.message).join(' '));
    },
    { octicon: 'code' },
  ),
  command(
    'run',
    'Run the code cell',
    ({ model: m }) => {
      const { sheet, active } = m.selection;
      return codeRunner(m).run({ sheet, row: active.row, col: active.col });
    },
    {
      gridKeybindings: ['Shift+Enter'],
      description: gridKeysDescription(['Shift+Enter'], false),
      octicon: 'play',
      // Before `cells.nextUp`, which Shift+Enter is everywhere but on a code cell.
      order: -1,
      isEnabled: onCodeCell,
    },
  ),
  command(
    'openEditor',
    'Open in editor',
    ({ model: m, grid }) => {
      if (grid?.openCodeEditor === undefined)
        throw new Error('cells.code.openEditor opens an editor on a grid: run it from a grid.');
      const { active } = m.selection;
      grid.openCodeEditor(active.row, active.col);
    },
    {
      // On a code cell, Enter and F2 open the overlay too, before `cells.nextDown` and `cells.editCell`.
      gridKeybindings: ['F4', 'Enter', 'F2'],
      description: gridKeysDescription(['F4', 'Enter', 'F2'], false),
      octicon: 'pencil',
      order: -1,
      isEnabled: onCodeCell,
    },
  ),
  command(
    'preview',
    'Show the outputs',
    ({ model: m, grid }) => {
      if (grid?.previewOutput === undefined)
        throw new Error('cells.code.preview shows a preview on a grid: run it from a grid.');
      const { active } = m.selection;
      if (!grid.previewOutput(active.row, active.col))
        throw new Error('This cell shows no output.');
    },
    {
      gridKeybindings: ['Alt+ArrowDown'],
      description: gridKeysDescription(['Alt+ArrowDown'], false),
      octicon: 'eye',
      isEnabled: onCodeCell,
    },
  ),
  command(
    'goToOutput',
    'Go to output',
    ({ model: m, grid }) => {
      if (grid?.focusOutput === undefined)
        throw new Error('cells.code.goToOutput reaches a frame on a grid: run it from a grid.');
      const { active } = m.selection;
      if (!grid.focusOutput(active.row, active.col)) throw new Error('This cell shows no output.');
    },
    { isEnabled: onCodeCell },
  ),
  command('runAll', 'Run every code cell of the sheet', ({ model: m }) =>
    codeRunner(m).runAll(m.selection.sheet),
  ),
  command('interrupt', 'Interrupt the code cell running', ({ model: m }) =>
    codeRunner(m).interrupt(),
  ),
];

/** The code cell commands and their context menu items. */
export const CellsCodePlugin = definePlugin({
  name: CELLS_CODE_PLUGIN,
  displayName: 'Code cells',
  description: 'Code cells: make one, run it on a kernel, run them all, interrupt.',
  octicon: 'code',
  commands: [...CODE_COMMANDS],
  contributes: [
    ...['insert', 'run', 'openEditor', 'preview', 'goToOutput', 'runAll'].map((id, i) =>
      contribution(
        CellsMenuItems,
        { command: `cells.code.${id}`, group: 'code' },
        { id: `cells.code.${id}`, order: 170 + i },
      ),
    ),
    // The code cells as a notebook (§3.13): one code cell each, in reading order, with its outputs.
    contribution(
      CellsExporters,
      {
        id: 'ipynb',
        mime: 'application/x-ipynb+json',
        extension: '.ipynb',
        write: async (model) => notebookText((model as CellsModel).workbook),
      },
      { id: 'ipynb', order: 130 },
    ),
  ],
});
