/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@datalayer/cells/chrome`: the toolbar, the formula bar with its name box,
 * and the sheet tabs, in Primer React (an optional peer of `@datalayer/cells`,
 * with `@primer/octicons-react`). Each reads the model of the nearest
 * `<CellsProvider>`, so a host puts them beside a `<Spreadsheet>` of the same
 * model; the grid's own context menu stays the grid's.
 *
 * @module chrome
 */

export { FormulaBar, type FormulaBarProps } from './FormulaBar.js';
export { SheetTabs, type SheetTabsProps } from './SheetTabs.js';
export { Toolbar, type ToolbarProps } from './Toolbar.js';
