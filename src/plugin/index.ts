/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@datalayer/cells/plugin`: workbooks in any Reactor shell, after
 * `@datalayer/decks/plugin`. The plugin adds a list of workbooks (sidebar
 * slot, with New, rename and delete), the open workbook with its toolbar,
 * formula bar and sheet tabs (main slot, and a "Spreadsheets" view in the
 * shell's selector), and commands to list, create, open, rename and delete
 * workbooks. The grids it opens run on the shell's own platform: a plugin
 * installed in the shell (a function, a command, a cell type) reaches every
 * open grid. `cellsShellPlugins()` is what a shell installs: the Cells core,
 * the built-ins and this plugin.
 *
 * @module plugin
 */

import { definePlugin, type PlatformInput } from '@datalayer/reactor';
import type { ReactorReactOutput } from '@datalayer/reactor/react';
import type { JSX } from 'react';
import { CellsCorePlugin, cellsBuiltins } from '../core/reactor.js';
import { ShellView, WorkbookCatalog } from './points.js';
import {
  closeWorkbook,
  createWorkbook,
  getWorkbooksState,
  openWorkbook,
  removeWorkbook,
  renameWorkbook,
} from './store.js';
import { WorkbookList, WorkbookView } from './views.js';

export const CELLS_PLUGIN_NAME = '@datalayer/cells';

export const CELLS_COMMANDS = {
  list: 'cells.workbooks.list',
  create: 'cells.workbooks.create',
  open: 'cells.workbooks.open',
  rename: 'cells.workbooks.rename',
  remove: 'cells.workbooks.remove',
} as const;

export interface CellsPluginConfig {
  /** Where the list renders. */
  listSlot: string;
  listOrder: number;
  /** Where the open workbook renders. */
  slot: string;
  /** Whether to contribute a "Spreadsheets" view to the shell's selector, and where. */
  shellView: boolean;
  shellViewOrder: number;
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${what} is a non-empty string.`);
  return v;
};

export const CellsPlugin = definePlugin<CellsPluginConfig, unknown, ReactorReactOutput>({
  name: CELLS_PLUGIN_NAME,
  version: '1.0.0',
  displayName: 'Spreadsheets',
  description: 'Workbooks in the shell: list them, open one, make a new one.',
  octicon: 'table',
  config: {
    listSlot: 'sidebar',
    listOrder: 10,
    slot: 'main',
    shellView: true,
    shellViewOrder: 45,
  },
  dependencies: [CellsCorePlugin],
  contributionPoints: [WorkbookCatalog],
  register: ({ registerCommand }) => {
    const undo = [
      registerCommand({
        id: CELLS_COMMANDS.list,
        name: 'Show the workbooks',
        description: 'Close the open workbook and list them all',
        category: 'Spreadsheets',
        execute: () => {
          closeWorkbook();
          return { ok: true, workbooks: getWorkbooksState().workbooks };
        },
      }),
      registerCommand<{ title?: string } | undefined, { ok: true; id: string }>({
        id: CELLS_COMMANDS.create,
        name: 'New workbook',
        description: 'An empty workbook, opened',
        category: 'Spreadsheets',
        execute: (argument) => ({ ok: true as const, id: createWorkbook(argument?.title) }),
      }),
      registerCommand<{ id: string } | undefined, { ok: true }>({
        id: CELLS_COMMANDS.open,
        name: 'Open a workbook',
        description: 'Show a workbook, by id',
        category: 'Spreadsheets',
        execute: (argument) => {
          openWorkbook(text(argument?.id, 'The id'));
          return { ok: true as const };
        },
      }),
      registerCommand<{ id: string; title: string } | undefined, { ok: true }>({
        id: CELLS_COMMANDS.rename,
        name: 'Rename a workbook',
        description: 'A new title for a workbook, by id',
        category: 'Spreadsheets',
        execute: (argument) => {
          renameWorkbook(text(argument?.id, 'The id'), text(argument?.title, 'The title'));
          return { ok: true as const };
        },
      }),
      registerCommand<{ id: string } | undefined, { ok: true }>({
        id: CELLS_COMMANDS.remove,
        name: 'Delete a workbook',
        description: 'Remove a workbook from the list, by id',
        category: 'Spreadsheets',
        execute: (argument) => {
          removeWorkbook(text(argument?.id, 'The id'));
          return { ok: true as const };
        },
      }),
    ];
    return () => undo.forEach((fn) => fn());
  },
  build: ({ config, contribute }) => {
    if (config.shellView)
      contribute(
        ShellView,
        { id: 'spreadsheets', title: 'Spreadsheets', order: config.shellViewOrder },
        { id: 'spreadsheets-view' },
      );
    return {
      components: [
        {
          id: 'cells-workbook-list',
          slot: config.listSlot,
          order: config.listOrder,
          Component: WorkbookList as () => JSX.Element,
        },
        {
          id: 'cells-workbook-view',
          slot: config.slot,
          Component: WorkbookView as () => JSX.Element,
        },
      ],
    };
  },
});

/** What a shell installs for spreadsheets: the Cells core, the built-ins, and the shell plugin. */
export function cellsShellPlugins(): PlatformInput[] {
  return [CellsCorePlugin, ...cellsBuiltins(), CellsPlugin];
}

export { ShellView, WorkbookCatalog } from './points.js';
export * from './store.js';
export { WorkbookList, WorkbookView } from './views.js';
export default CellsPlugin;
