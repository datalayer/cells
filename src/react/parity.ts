/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * API parity: every runtime export of `./core`, and every public member of
 * the model, mapped to the React surface that covers it. The parity test
 * fails on a core export or a model member missing here, and on an entry
 * naming a hook or component that `@datalayer/cells` does not export.
 *
 * - `hook` / `component`: exported from `@datalayer/cells`.
 * - `reexport`: a pure function or a constant, used as it is from
 *   `@datalayer/cells` (it re-exports `./core`); no state, so nothing to wrap.
 *
 * @module react/parity
 */

export type Surface =
  { readonly kind: 'hook' | 'component'; readonly name: string } | { readonly kind: 'reexport' };

const hook = (name: string): Surface => ({ kind: 'hook', name });
const component = (name: string): Surface => ({ kind: 'component', name });
const reexport: Surface = { kind: 'reexport' };

/** Every runtime export of `./core`. */
export const CORE_EXPORTS: Readonly<Record<string, Surface>> = {
  // The model
  createCellsModel: hook('useCellsModel'),
  fromRows: hook('useCellsFromRows'),
  validateWorkbook: hook('useCellsWorkbook'),
  FORMAT_VERSION: reexport,
  DEFAULT_LIMITS: reexport,
  DEFAULT_HISTORY_LIMITS: reexport,
  // Reactor
  CellsCorePlugin: hook('useCellsReactor'),
  CELLS_CORE_PLUGIN: hook('usePlugin'),
  buildCellsReactor: hook('useCellsReactor'),
  cellsBuiltins: hook('useCellsReactor'),
  CELLS_POINTS: hook('useContributions'),
  CellsPatchOps: hook('useContributions'),
  CellsCommands: hook('useCommandTypes'),
  CellsFunctions: hook('useContributions'),
  CellsCellTypes: hook('useContributions'),
  CellsRenderLayers: hook('useContributions'),
  CellsClipboard: hook('useContributions'),
  CellsFillRules: hook('useContributions'),
  CellsImporters: hook('useContributions'),
  CellsExporters: hook('useContributions'),
  CellsDataSources: hook('useContributions'),
  CellsCollabProvider: hook('useSingleContribution'),
  CellsToolbarItems: hook('useContributions'),
  CellsMenuItems: hook('useContributions'),
  CellsEditGate: hook('useContributions'),
  PointTable: hook('useContributions'),
  firstContribution: hook('useSingleContribution'),
  optionalContribution: hook('useSingleContribution'),
  CellsFunctionsPlugin: hook('useCellsReactor'),
  // Charts (§3.12): the commands through useCharts, one chart through useChart
  inferChartData: hook('useCharts'),
  chartPoints: hook('useChart'),
  chartData: hook('useChart'),
  chartRect: hook('useChart'),
  chartOption: hook('useChart'),
  chartPlaceholder: hook('useChart'),
  chartRendererOf: hook('useSingleContribution'),
  chartTransformTable: hook('useContributions'),
  chartTypeTable: hook('useContributions'),
  resolveChart: hook('useChart'),
  resolveChartType: hook('useContributions'),
  CellsChartTypes: hook('useContributions'),
  CellsChartOptions: hook('useContributions'),
  CellsChartRenderer: hook('useSingleContribution'),
  chartRanges: hook('useChart'),
  chartRefs: hook('useChart'),
  refZone: hook('useChart'),
  checkChart: hook('useCharts'),
  chartProblem: hook('useCharts'),
  zoneRef: hook('useCharts'),
  BUILTIN_CHART_TYPES: reexport,
  CHART_VARIANTS: reexport,
  MAX_CHART_POINTS: reexport,
  CELLS_FUNCTIONS_PLUGIN: hook('usePlugin'),
  // Formulas: pure functions, for function authors and hosts handling formula text
  numbers: reexport,
  FormulaSyntaxError: reexport,
  parseFormula: reexport,
  printFormula: reexport,
  shapeOf: reexport,
  translateFormula: reexport,
  transposeFormula: reexport,
  compare: reexport,
  ErrorValue: reexport,
  fail: reexport,
  numberToText: reexport,
  toBoolean: reexport,
  toNumber: reexport,
  toText: reexport,
  CellsEditingPlugin: hook('useCellsCommands'),
  CELLS_EDITING_PLUGIN: hook('usePlugin'),
  EDITING_COMMANDS: hook('useExecuteCommand'),
  CellsClipboardPlugin: hook('useCellsReactor'),
  CELLS_CLIPBOARD_PLUGIN: hook('usePlugin'),
  allowPaste: hook('useClipboard'),
  checkSlice: hook('useClipboard'),
  parseTSV: reexport,
  toTSV: reexport,
  sliceFromText: reexport,
  SLICE_VERSION: reexport,
  CellsFillPlugin: hook('useCellsReactor'),
  CELLS_FILL_PLUGIN: hook('usePlugin'),
  FILL_RULES: hook('useContributions'),
  // Commands and patches: plugin-authoring helpers, pure
  OK: reexport,
  refuse: reexport,
  parseInput: reexport,
  cellsPatch: reexport,
  snapshot: reexport,
  snapshotOf: reexport,
  snapshotEntries: reexport,
  EMPTY_SNAPSHOT: reexport,
  // References and selection
  resolveCell: hook('useCell'),
  resolveRange: hook('useRange'),
  initialSelection: hook('useSelection'),
  selectCell: hook('useSelection'),
  addZone: hook('useSelection'),
  navigate: hook('useSelection'),
  navigationGrid: hook('useSelection'),
  dataEdge: hook('useSelection'),
  // Number formats: pure (a compiled format is a pure function)
  compileFormat: reexport,
  checkFormatCode: reexport,
  EN_US: reexport,
  FormatCodeError: hook('useStyle'),
  // Values, styles, A1 notation: pure
  CELL_ERRORS: reexport,
  cellError: reexport,
  isCellError: reexport,
  isErrorCode: reexport,
  checkStyle: hook('useStyle'),
  columnIndex: reexport,
  columnLetters: reexport,
  parseA1: reexport,
  parseZone: reexport,
  splitSheet: reexport,
  toA1: reexport,
  zoneContains: reexport,
  zoneOf: reexport,
  zoneSize: reexport,
  zoneToA1: reexport,
  zonesOverlap: reexport,
};

/** Every public member of `CellsModel`. */
export const MODEL_MEMBERS: Readonly<Record<string, Surface>> = {
  reactor: hook('useCellsReactor'),
  workbook: hook('useSheets'),
  readOnly: hook('useCells'),
  dispatch: hook('useDispatch'),
  transact: hook('useDispatch'),
  undo: hook('useHistory'),
  redo: hook('useHistory'),
  canUndo: hook('useHistory'),
  canRedo: hook('useHistory'),
  historyLabels: hook('useHistory'),
  subscribe: hook('useOnChange'),
  subscribeSelection: hook('useSelection'),
  revision: hook('useCellsRevision'),
  selection: hook('useSelection'),
  select: hook('useSelection'),
  sheets: hook('useSheets'),
  sheet: hook('useAxis'),
  content: hook('useCell'),
  value: hook('useCellValue'),
  style: hook('useStyle'),
  toJSON: hook('useExport'),
  toRows: hook('useExport'),
  loadColumns: hook('useLoad'),
  replaceData: hook('useLoad'),
  clipboardMark: hook('useClipboard'),
  copy: hook('useClipboard'),
  paste: hook('useClipboard'),
  clearClipboardMark: hook('useClipboard'),
  edit: hook('useCellsEditor'),
  startEdit: hook('useCellsEditor'),
  setEditText: hook('useCellsEditor'),
  commitEdit: hook('useCellsEditor'),
  cancelEdit: hook('useCellsEditor'),
  subscribeEdit: hook('useCellsEditor'),
  stats: hook('useCellsStats'),
  commandTypes: hook('useCommandTypes'),
  patchOp: hook('useContributions'),
  patchOpNames: hook('useContributions'),
  functionNames: hook('useContributions'),
  formulaFunction: hook('useContributions'),
  chartRevision: hook('useChart'),
  chartData: hook('useChart'),
  chartsPending: hook('useCharts'),
};

void component;
