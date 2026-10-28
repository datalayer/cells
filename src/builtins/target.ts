/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The grid a Cells command acts on when it is run with no argument: a
 * command palette, a host's menu or an agent runs `cells.bold` by its id
 * alone, and it reaches the grid that last had the focus (or, before any
 * focus, the last one mounted). A grid's own keys and menus pass their
 * argument and never read this.
 *
 * @module builtins/target
 */

import type { CellsCommandArgument } from './editing.js';

let current: CellsCommandArgument | undefined;

/** The grid a command run with no argument acts on; `<Spreadsheet>` sets it on mount and focus. */
export function setCellsCommandTarget(target: CellsCommandArgument): void {
  current = target;
}

/** Forget a grid that unmounts, if it is the target. */
export function clearCellsCommandTarget(target: CellsCommandArgument): void {
  if (current === target) current = undefined;
}

/** A command's argument, or the target grid's when none is given; a sentence when there is neither. */
export function cellsArgument(id: string, argument: CellsCommandArgument | undefined) {
  if (argument !== undefined && argument.model !== undefined) return argument;
  if (current !== undefined) return current;
  throw new Error(`${id} runs on a grid's model: focus a grid, or execute it with { model }.`);
}
