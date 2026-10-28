/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The grid's moves, as Reactor commands contributed by a plugin like any
 * other: the arrows, with Mod (to the edge of the data) and Shift (extend);
 * Tab and Enter (inside a selection, cycling through it); Home, Mod+Home,
 * Mod+End; PageUp and PageDown; selecting columns, rows and the whole sheet.
 * Their keys are grid keys (`gridKeybindings`): bound on the grid's focus
 * target alone, so the same keys keep their meaning in every other field.
 *
 * @module builtins/navigation
 */

import { definePlugin } from '@datalayer/reactor';
import { initialSelection, navigate, type Navigation, navigationGrid } from '../core/selection.js';
import { type CellsCommand, type CellsCommandArgument, gridKeysDescription } from './editing.js';
import { cellsArgument } from './target.js';

/** The name of `CellsNavigationPlugin`. */
export const CELLS_NAVIGATION_PLUGIN = '@datalayer/cells-navigation';

/** Move or extend the selection, on the sheet the grid shows, and scroll to where it went. */
function go(argument: CellsCommandArgument, nav: Navigation): void {
  const { model: m, grid } = argument;
  const sheet = grid?.sheet ?? m.selection.sheet;
  const before = m.selection;
  const s = before.sheet === sheet ? before : initialSelection(sheet);
  const next = navigate(s, nav, navigationGrid(m.sheet(sheet)));
  m.select(next);
  if (grid === undefined) return;
  const z = next.zones[next.zones.length - 1];
  // Extending scrolls to the moving corner; anything else, to the active cell.
  const target =
    nav.type === 'move' && nav.extend
      ? {
          row: z.top === next.anchor.row ? z.bottom : z.top,
          col: z.left === next.anchor.col ? z.right : z.left,
        }
      : next.active;
  grid.scrollTo(target.row, target.col);
}

function move(
  id: string,
  name: string,
  keys: readonly string[],
  nav: (a: CellsCommandArgument) => Navigation,
  octicon?: string,
): CellsCommand {
  return {
    id: `cells.${id}`,
    name,
    category: 'Cells',
    description: gridKeysDescription(keys, false),
    gridKeybindings: keys,
    ...(octicon !== undefined ? { octicon } : {}),
    execute: (argument: CellsCommandArgument) => {
      const a = cellsArgument(`cells.${id}`, argument);
      go(a, nav(a));
    },
  };
}

/** The rows a page holds: the grid's, or a sentence when no grid runs the command. */
function pageRows(id: string, a: CellsCommandArgument): number {
  if (a.grid === undefined) throw new Error(`${id} moves by a grid's page: run it from a grid.`);
  return a.grid.pageRows;
}

const DIRECTIONS = [
  ['Up', 'up', 'ArrowUp', 'arrow-up'],
  ['Down', 'down', 'ArrowDown', 'arrow-down'],
  ['Left', 'left', 'ArrowLeft', 'arrow-left'],
  ['Right', 'right', 'ArrowRight', 'arrow-right'],
] as const;

/** The grid's moves (arrows, Tab, Enter, Home, Mod+End, the pages, select all, …) as Reactor commands with their grid keys. */
export const NAVIGATION_COMMANDS: readonly CellsCommand[] = [
  ...DIRECTIONS.flatMap(([Dir, dir, key, octicon]) => [
    move(`move${Dir}`, `Move ${dir}`, [key], () => ({ type: 'move', dir }), octicon),
    move(`jump${Dir}`, `Jump ${dir} to the edge of the data`, [`Mod+${key}`], () => ({
      type: 'move',
      dir,
      jump: true,
    })),
    move(`extend${Dir}`, `Extend the selection ${dir}`, [`Shift+${key}`], () => ({
      type: 'move',
      dir,
      extend: true,
    })),
    move(
      `extendJump${Dir}`,
      `Extend the selection ${dir} to the edge of the data`,
      [`Mod+Shift+${key}`],
      () => ({ type: 'move', dir, jump: true, extend: true }),
    ),
  ]),
  move('nextRight', 'Next cell to the right', ['Tab'], () => ({ type: 'cycle', by: 'row' })),
  move('nextLeft', 'Next cell to the left', ['Shift+Tab'], () => ({
    type: 'cycle',
    by: 'row',
    reverse: true,
  })),
  move('nextDown', 'Next cell below', ['Enter'], () => ({ type: 'cycle', by: 'col' })),
  move('nextUp', 'Next cell above', ['Shift+Enter'], () => ({
    type: 'cycle',
    by: 'col',
    reverse: true,
  })),
  move('goToRowStart', "Go to the row's first cell", ['Home'], () => ({ type: 'home' })),
  move('extendToRowStart', "Extend the selection to the row's first cell", ['Shift+Home'], () => ({
    type: 'home',
    extend: true,
  })),
  move('goToStart', 'Go to A1', ['Mod+Home'], () => ({ type: 'home', ctrl: true }), 'home'),
  move('extendToStart', 'Extend the selection to A1', ['Mod+Shift+Home'], () => ({
    type: 'home',
    ctrl: true,
    extend: true,
  })),
  move('goToEnd', 'Go to the last cell with data', ['Mod+End'], () => ({ type: 'end' })),
  move('extendToEnd', 'Extend the selection to the last cell with data', ['Mod+Shift+End'], () => ({
    type: 'end',
    extend: true,
  })),
  move('pageDown', 'Page down', ['PageDown'], (a) => ({
    type: 'page',
    dir: 'down',
    rows: pageRows('cells.pageDown', a),
  })),
  move('pageUp', 'Page up', ['PageUp'], (a) => ({
    type: 'page',
    dir: 'up',
    rows: pageRows('cells.pageUp', a),
  })),
  move('extendPageDown', 'Extend the selection a page down', ['Shift+PageDown'], (a) => ({
    type: 'page',
    dir: 'down',
    rows: pageRows('cells.extendPageDown', a),
    extend: true,
  })),
  move('extendPageUp', 'Extend the selection a page up', ['Shift+PageUp'], (a) => ({
    type: 'page',
    dir: 'up',
    rows: pageRows('cells.extendPageUp', a),
    extend: true,
  })),
  move('selectColumns', 'Select the columns', ['Ctrl+Space'], () => ({ type: 'selectColumns' })),
  move('selectRows', 'Select the rows', ['Shift+Space'], () => ({ type: 'selectRows' })),
  move('selectAll', 'Select the whole sheet', ['Mod+A'], () => ({ type: 'selectAll' })),
];

/** The grid's moves as Reactor commands: arrows, Tab, Enter, Home, Mod+End, the pages, select columns, rows and all. */
export const CellsNavigationPlugin = definePlugin({
  name: CELLS_NAVIGATION_PLUGIN,
  displayName: 'Cells navigation',
  description: 'Move, jump, extend and select from the keyboard, or from a command palette.',
  octicon: 'move-to-end',
  commands: [...NAVIGATION_COMMANDS],
});
