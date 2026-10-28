/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Cells on Reactor: the core plugin, which opens every `datalayer.cells.*`
 * point and contributes the core patch ops and commands through them, and
 * the builder of a platform for hosts that run no Reactor of their own.
 *
 * @module core/reactor
 */

import {
  buildReactorFromPlugins,
  contribution,
  definePlugin,
  type PlatformInput,
  type ReactorPlatform,
} from '@datalayer/reactor';
import { CELLS_POINTS, CellsCommands, CellsPatchOps } from '../points/index.js';
import { CORE_COMMANDS } from './commands.js';
import { CORE_PATCH_OPS } from './patches.js';
import { CHART_COMMANDS, chartOp } from './charts.js';
import { codeOp, setCode } from './code.js';
import { bindDataSource, dataSourceOp } from './dataSources.js';
import { CellsClipboardPlugin } from '../builtins/clipboard.js';
import { CellsEditingPlugin } from '../builtins/editing.js';
import { CellsFillPlugin } from '../builtins/fill.js';
import { CellsNavigationPlugin } from '../builtins/navigation.js';
import { CellsChartCommandsPlugin } from '../builtins/charts.js';
import { CellsCellTypesPlugin } from '../builtins/cellTypes.js';
import { CellsFunctionsPlugin } from '../builtins/functions/index.js';

/** The name of `CellsCorePlugin`; a platform without it is refused. */
export const CELLS_CORE_PLUGIN = '@datalayer/cells-core';

/**
 * The core plugin. Every grid needs it: it declares the points, and its
 * contributions are the core's own patch ops and commands, at `order: 100`
 * so a plugin may place its own before or after them.
 */
export const CellsCorePlugin = definePlugin({
  name: CELLS_CORE_PLUGIN,
  displayName: 'Cells',
  description: 'The spreadsheet core: its contribution points, patch ops and commands.',
  octicon: 'table',
  contributionPoints: [...CELLS_POINTS],
  contributes: [
    ...[...CORE_PATCH_OPS, chartOp, dataSourceOp, codeOp].map((op) =>
      contribution(CellsPatchOps, op, { id: op.op, order: 100 }),
    ),
    ...[...CORE_COMMANDS, ...CHART_COMMANDS, bindDataSource, setCode].map((handler) =>
      contribution(CellsCommands, handler, { id: handler.type, order: 100 }),
    ),
  ],
});

/** The built-in plugins a grid gets by default, besides the core. More arrive with each feature. */
export function cellsBuiltins(): PlatformInput[] {
  return [
    CellsEditingPlugin,
    CellsNavigationPlugin,
    CellsClipboardPlugin,
    CellsFillPlugin,
    CellsFunctionsPlugin,
    CellsChartCommandsPlugin,
    CellsCellTypesPlugin,
  ];
}

/**
 * A started Reactor platform holding the core, the built-ins and `plugins`.
 * A host already running Reactor passes its own platform to the model instead,
 * with `CellsCorePlugin` among its plugins.
 */
export function buildCellsReactor(plugins: readonly PlatformInput[] = []): ReactorPlatform {
  const reactor = buildReactorFromPlugins([CellsCorePlugin, ...cellsBuiltins(), ...plugins]);
  reactor.start();
  return reactor;
}
