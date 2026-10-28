/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@datalayer/cells/core`: the headless spreadsheet model. No React, no DOM;
 * it runs in a browser, in Node and in a worker. Extended through the
 * Reactor contribution points it opens (`datalayer.cells.*`).
 *
 * The runtime exports are a curated list: what a host or a plugin uses. The
 * storage classes behind the model are exported as types only.
 *
 * @module core
 */

export type { Axis, AxisOptions, AxisSegment } from './axis.js';
export type { CellContent } from './cells.js';
export {
  type AddSheetCommand,
  type CellInput,
  cellsPatch,
  type ClearCommand,
  type Command,
  type CommandContext,
  type CommandResult,
  type CoreCommand,
  type DeleteAxisCommand,
  type DeleteSheetCommand,
  type FreezeCommand,
  type HideAxisCommand,
  type InsertAxisCommand,
  type MergeCommand,
  type MoveAxisCommand,
  type MoveSheetCommand,
  OK,
  parseInput,
  type Refusal,
  type RefusalReason,
  refuse,
  type RenameSheetCommand,
  type ResizeAxisCommand,
  type SetCellsCommand,
  type SetStyleCommand,
  type UnmergeCommand,
} from './commands.js';
export {
  type CellsCell,
  type CellsSheet,
  type CellsWorkbook,
  FORMAT_VERSION,
  fromRows,
  type JsonValue,
  validateWorkbook,
} from './format.js';
export { DEFAULT_HISTORY_LIMITS, type HistoryLimits } from './history.js';
export {
  checkFormatCode,
  compileFormat,
  EN_US,
  type Formatted,
  FormatCodeError,
  type NumberFormatter,
  type NumberLocale,
} from './numfmt.js';
export {
  type CellsModel,
  type CellsModelOptions,
  type ChangeListener,
  createCellsModel,
  type ClipboardMark,
  type EditListener,
  type EditState,
  type Origin,
  type SelectionListener,
  type Transaction,
} from './model.js';
export {
  type AxisName,
  type CellsPatch,
  type CorePatch,
  EMPTY_SNAPSHOT,
  type Patch,
  type PatchOp,
  type Snapshot,
  snapshot,
  snapshotEntries,
  snapshotOf,
} from './patches.js';
export { buildCellsReactor, CELLS_CORE_PLUGIN, cellsBuiltins, CellsCorePlugin } from './reactor.js';
export { resolveCell, resolveRange, type ResolvedCell, type ResolvedRange } from './refs.js';
export {
  addZone,
  dataEdge,
  type Direction,
  initialSelection,
  navigate,
  type Navigation,
  type NavigationGrid,
  navigationGrid,
  selectCell,
  type SelectionState,
} from './selection.js';
export {
  type BorderSide,
  type BorderStyle,
  checkStyle,
  type HorizontalAlign,
  type Style,
  type VerticalAlign,
} from './styles.js';
export {
  CELL_ERRORS,
  type CellError,
  type CellErrorCode,
  cellError,
  type CellValue,
  isCellError,
  isErrorCode,
} from './values.js';
export { DEFAULT_LIMITS, type Frozen, type Limits, type Sheet, type Workbook } from './workbook.js';
export {
  type CellAddress,
  columnIndex,
  columnLetters,
  parseA1,
  parseZone,
  type Position,
  splitSheet,
  toA1,
  type Zone,
  zoneContains,
  zoneOf,
  zoneSize,
  zoneToA1,
  zonesOverlap,
} from './zone.js';
export * from '../points/index.js';
export {
  allowPaste,
  checkSlice,
  type PasteCommand,
  type PasteOptions,
  parseTSV,
  type Slice,
  type SliceCell,
  SLICE_VERSION,
  sliceFromText,
  toTSV,
} from './clipboard.js';
export { CELLS_CLIPBOARD_PLUGIN, CellsClipboardPlugin } from '../builtins/clipboard.js';
export {
  CELLS_FILL_PLUGIN,
  CellsFillPlugin,
  FILL_RULES,
  type FillCommand,
  type SortCommand,
} from '../builtins/fill.js';
export {
  BUILTIN_CHART_TYPES,
  type CellOffset,
  CHART_VARIANTS,
  type ChartAnchor,
  type ChartAxis,
  type ChartCommand,
  type ChartPatch,
  type ChartSeries,
  type ChartSpec,
  type ChartData,
  chartData,
  chartPoints,
  chartProblem,
  chartRanges,
  chartRect,
  chartRefs,
  type ChartSeriesData,
  checkChart,
  type DeleteChartCommand,
  inferChartData,
  type InsertChartCommand,
  MAX_CHART_POINTS,
  type MoveChartCommand,
  type Ref,
  refZone,
  type ResizeChartCommand,
  type UpdateChartCommand,
  zoneRef,
} from './charts.js';
export {
  chartOption,
  chartPlaceholder,
  chartRendererOf,
  chartTransformTable,
  chartTypeTable,
  resolveChart,
  resolveChartType,
  type ResolvedChart,
} from './chartOption.js';
export {
  CELLS_FUNCTIONS_PLUGIN,
  CellsFunctionsPlugin,
  numbers,
} from '../builtins/functions/index.js';
export type { Ast, RefPart } from '../formula/ast.js';
export { FormulaSyntaxError, parseFormula } from '../formula/parser.js';
export { printFormula, shapeOf, translateFormula, transposeFormula } from '../formula/normal.js';
export {
  compare,
  ErrorValue,
  fail,
  type Matrix,
  numberToText,
  type Reference,
  toBoolean,
  toNumber,
  toText,
  type Union,
  type Value,
} from '../formula/values.js';
export {
  CELLS_EDITING_PLUGIN,
  type CellsCommandArgument,
  CellsEditingPlugin,
  EDITING_COMMANDS,
} from '../builtins/editing.js';
