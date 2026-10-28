/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The React surface of the model: a provider and hooks, so a React host
 * reaches everything the core can do without holding a model by hand
 * (§ API parity). Every hook reads through `useSyncExternalStore` on the
 * model's revision, so a component re-renders when, and only when, the
 * model changed.
 *
 * @module react/hooks
 */

import type { ContributionPoint, ReactorCommand } from '@datalayer/reactor';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CellContent } from '../core/cells.js';
import {
  type ChartData,
  type ChartAnchor,
  type ChartSpec,
  chartPoints,
  inferChartData,
  type MoveChartCommand,
  type ResizeChartCommand,
  type UpdateChartCommand,
} from '../core/charts.js';
import type { Command, CommandResult } from '../core/commands.js';
import { type CellsWorkbook, fromRows, validateWorkbook } from '../core/format.js';
import {
  type CellsModel,
  type CellsModelOptions,
  type ClipboardMark,
  createCellsModel,
  type EditState,
} from '../core/model.js';
import type { PasteOptions, Slice } from '../core/clipboard.js';
import { resolveCell, resolveRange } from '../core/refs.js';
import {
  addZone,
  initialSelection,
  navigate,
  type Navigation,
  navigationGrid,
  selectCell,
  type SelectionState,
} from '../core/selection.js';
import type { Style } from '../core/styles.js';
import type { CellValue } from '../core/values.js';
import { type Position, type Zone } from '../core/zone.js';
import { type Resolved, optionalContribution, firstContribution } from '../points/index.js';

const CellsContext = createContext<CellsModel | null>(null);

/** Makes a model the one the hooks below read. `<Spreadsheet>` provides its own. */
export function CellsProvider({ model, children }: { model: CellsModel; children?: ReactNode }) {
  return <CellsContext.Provider value={model}>{children}</CellsContext.Provider>;
}

/**
 * Create a model once, on first render, and keep it: the controlled mode's
 * model. The factory runs once; later renders ignore it.
 */
export function useCellsModel(factory: () => CellsModel): CellsModel {
  const [model] = useState(factory);
  return model;
}

/** A model of one sheet from rows of values, created once. */
export function useCellsFromRows(
  rows: readonly (readonly CellValue[])[],
  options: Omit<CellsModelOptions, 'data'> = {},
): CellsModel {
  return useCellsModel(() => createCellsModel({ ...options, data: fromRows(rows) }));
}

/** A model from a `CellsWorkbook`, validated, created once. */
export function useCellsWorkbook(
  data: CellsWorkbook,
  options: Omit<CellsModelOptions, 'data'> = {},
): CellsModel {
  return useCellsModel(() => createCellsModel({ ...options, data: validateWorkbook(data) }));
}

/** The model of the nearest `CellsProvider` (or `<Spreadsheet>`). Throws outside one. */
export function useCells(): CellsModel {
  const model = useContext(CellsContext);
  if (model === null) {
    throw new Error(
      'useCells reads the model of a <CellsProvider> or a <Spreadsheet>; this component is in neither.',
    );
  }
  return model;
}

/** The model's revision: re-renders the caller on every change, selection included. */
export function useCellsRevision(): number {
  const model = useCells();
  const subscribe = useCallback(
    (notify: () => void) => {
      const a = model.subscribe(notify);
      const b = model.subscribeSelection(notify);
      return () => {
        a();
        b();
      };
    },
    [model],
  );
  return useSyncExternalStore(
    subscribe,
    () => model.revision,
    () => model.revision,
  );
}

/** A value derived from the model, recomputed when the model changed. */
function useDerived<T>(compute: (model: CellsModel) => T, deps: readonly unknown[]): T {
  const model = useCells();
  const revision = useCellsRevision();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => compute(model), [model, revision, ...deps]);
}

/** A cell: what it holds, what it shows, its style. `ref` is `B3` or `Sheet2!B3`. */
export function useCell(ref: string): {
  content: CellContent | null;
  value: CellValue;
  style: Style;
} {
  return useDerived(
    (m) => {
      const { sheet, row, col } = resolveCell(m, ref);
      return {
        content: m.content(sheet, row, col),
        value: m.value(sheet, row, col),
        style: m.style(sheet, row, col),
      };
    },
    [ref],
  );
}

/** What a cell shows. */
export function useCellValue(ref: string): CellValue {
  return useCell(ref).value;
}

/** What a range shows, as rows. `ref` is `A1:D20` or `Sheet2!A1:D20`. */
export function useRange(ref: string): CellValue[][] {
  return useDerived(
    (m) => {
      const { sheet, zone } = resolveRange(m, ref);
      return m.toRows(zone, sheet);
    },
    [ref],
  );
}

/** A cell's style, and a setter that merges into it (one undo step). */
export function useStyle(ref: string): {
  style: Style;
  set: (style: Style | null) => CommandResult;
} {
  const model = useCells();
  const { style } = useCell(ref);
  const set = useCallback(
    (next: Style | null) => {
      const { sheet, zone } = resolveRange(model, ref);
      return model.dispatch({ type: 'SET_STYLE', sheet, zone, style: next });
    },
    [model, ref],
  );
  return { style, set };
}

/** Run commands of a type: `useCommand('INSERT_AXIS')(args)`. Returns the result, refusals and all. */
export function useCommand<C extends Command>(
  type: C['type'],
): (args: Omit<C, 'type'>) => CommandResult {
  const model = useCells();
  return useCallback(
    (args: Omit<C, 'type'>) => model.dispatch({ ...args, type } as Command),
    [model, type],
  );
}

/** Dispatch any command, and group several into one undo step. */
export function useDispatch(): {
  dispatch: (command: Command) => CommandResult;
  transact: <T>(label: string, fn: () => T) => T;
} {
  const model = useCells();
  return useMemo(
    () => ({
      dispatch: (c: Command) => model.dispatch(c),
      transact: <T,>(label: string, fn: () => T) => model.transact(label, fn),
    }),
    [model],
  );
}

/** Undo and redo, with what they would do. */
export function useHistory(): {
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  transact: <T>(label: string, fn: () => T) => T;
} {
  const model = useCells();
  return useDerived(
    (m) => ({
      undo: () => model.undo(),
      redo: () => model.redo(),
      canUndo: m.canUndo,
      canRedo: m.canRedo,
      undoLabel: m.historyLabels.undo,
      redoLabel: m.historyLabels.redo,
      transact: <T,>(label: string, fn: () => T) => model.transact(label, fn),
    }),
    [],
  );
}

/** The selection, and what changes it: `select('B2:C4')`, `navigate({ type: 'move', dir: 'down' })`. */
export function useSelection(): SelectionState & {
  select: (ref: string, options?: { extend?: boolean; add?: boolean }) => void;
  set: (selection: SelectionState) => void;
  navigate: (nav: Navigation) => void;
  activate: (sheet: string) => void;
} {
  const model = useCells();
  return useDerived(
    (m) => ({
      ...m.selection,
      select: (ref: string, options: { extend?: boolean; add?: boolean } = {}) => {
        const { sheet, zone } = resolveRange(model, ref);
        const at: Position = { row: zone.top, col: zone.left };
        const base =
          sheet === model.selection.sheet ? model.selection : initialSelection(sheet, at);
        let next: SelectionState;
        if (options.add) next = addZone(base, zone);
        else if (zone.top === zone.bottom && zone.left === zone.right)
          next = selectCell(base, at, options.extend);
        else next = { sheet, zones: [zone], anchor: at, active: at };
        model.select(next);
      },
      set: (s: SelectionState) => model.select(s),
      navigate: (nav: Navigation) => {
        const s = model.selection;
        model.select(navigate(s, nav, navigationGrid(model.sheet(s.sheet))));
      },
      activate: (sheet: string) => model.select(initialSelection(model.sheet(sheet).id)),
    }),
    [],
  );
}

export interface SheetInfo {
  readonly id: string;
  readonly name: string;
  readonly frozen: { rows: number; cols: number };
  readonly merges: readonly Zone[];
}

/** The sheets, the active one, and the commands on them. */
export function useSheets(): {
  sheets: SheetInfo[];
  active: string;
  add: (name?: string, at?: number) => CommandResult;
  rename: (sheet: string, name: string) => CommandResult;
  move: (sheet: string, to: number) => CommandResult;
  remove: (sheet: string) => CommandResult;
  freeze: (sheet: string, rows: number, cols: number) => CommandResult;
  activate: (sheet: string) => void;
} {
  const model = useCells();
  return useDerived(
    (m) => ({
      sheets: m.sheets.map((s) => ({
        id: s.id,
        name: s.name,
        frozen: { ...s.frozen },
        merges: [...s.merges],
      })),
      active: m.selection.sheet,
      add: (name?: string, at?: number) => model.dispatch({ type: 'ADD_SHEET', name, at }),
      rename: (sheet: string, name: string) =>
        model.dispatch({ type: 'RENAME_SHEET', sheet, name }),
      move: (sheet: string, to: number) => model.dispatch({ type: 'MOVE_SHEET', sheet, to }),
      remove: (sheet: string) => model.dispatch({ type: 'DELETE_SHEET', sheet }),
      freeze: (sheet: string, rows: number, cols: number) =>
        model.dispatch({ type: 'FREEZE', sheet, rows, cols }),
      activate: (sheet: string) => model.select(initialSelection(model.sheet(sheet).id)),
    }),
    [],
  );
}

/** An axis of a sheet: counts, sizes and offsets, and the commands on it. */
export function useAxis(sheet: string, axis: 'rows' | 'cols') {
  const model = useCells();
  return useDerived(
    (m) => {
      const a = axis === 'rows' ? m.sheet(sheet).rows : m.sheet(sheet).cols;
      return {
        count: a.count,
        extent: a.extent,
        sizeOf: (i: number) => a.sizeOf(i),
        isHidden: (i: number) => a.isHidden(i),
        offsetOf: (i: number) => a.offsetOf(i),
        indexAt: (px: number) => a.indexAt(px),
        resize: (from: number, to: number, size: number) =>
          model.dispatch({ type: 'RESIZE_AXIS', sheet, axis, from, to, size }),
        hide: (from: number, to: number, hidden = true) =>
          model.dispatch({ type: 'HIDE_AXIS', sheet, axis, from, to, hidden }),
        insert: (at: number, n = 1) => model.dispatch({ type: 'INSERT_AXIS', sheet, axis, at, n }),
        remove: (at: number, n = 1) => model.dispatch({ type: 'DELETE_AXIS', sheet, axis, at, n }),
        move: (at: number, n: number, to: number) =>
          model.dispatch({ type: 'MOVE_AXIS', sheet, axis, at, n, to }),
      };
    },
    [sheet, axis],
  );
}

/**
 * The edit buffer the in-cell editor and a formula bar share: what is being
 * edited and how, and the verbs. A formula bar binds an input to `text` and
 * `setText`, and calls `start` on focus and `commit` on Enter.
 */
export function useCellsEditor(): {
  edit: EditState | null;
  start: (ref?: string, text?: string) => void;
  setText: (text: string) => void;
  commit: () => CommandResult;
  cancel: () => void;
} {
  const model = useCells();
  const subscribe = useCallback((notify: () => void) => model.subscribeEdit(notify), [model]);
  const edit = useSyncExternalStore(
    subscribe,
    () => model.edit,
    () => model.edit,
  );
  return useMemo(
    () => ({
      edit,
      start: (ref?: string, text?: string) => {
        if (ref === undefined) {
          model.startEdit(undefined, text);
          return;
        }
        const cell = resolveCell(model, ref);
        if (cell.sheet !== model.selection.sheet) model.select(initialSelection(cell.sheet, cell));
        model.startEdit({ row: cell.row, col: cell.col }, text);
      },
      setText: (text: string) => model.setEditText(text),
      commit: () => model.commitEdit(),
      cancel: () => model.cancelEdit(),
    }),
    [model, edit],
  );
}

/** Copy, cut and paste on the model, and the marching ants' zone. */
export function useClipboard(): {
  mark: ClipboardMark | null;
  copy: (ref?: string) => Slice;
  cut: (ref?: string) => Slice;
  paste: (slice: Slice, ref?: string, options?: PasteOptions) => CommandResult;
  clearMark: () => void;
} {
  const model = useCells();
  return useDerived((m) => {
    const zoneOf = (ref?: string) => (ref === undefined ? undefined : resolveRange(model, ref));
    return {
      mark: m.clipboardMark,
      copy: (ref?: string) => {
        const r = zoneOf(ref);
        return model.copy(r?.zone, { sheet: r?.sheet });
      },
      cut: (ref?: string) => {
        const r = zoneOf(ref);
        return model.copy(r?.zone, { sheet: r?.sheet, cut: true });
      },
      paste: (slice: Slice, ref?: string, options?: PasteOptions) => {
        const at = ref === undefined ? undefined : resolveCell(model, ref);
        if (at !== undefined && at.sheet !== model.selection.sheet)
          model.select(initialSelection(at.sheet, at));
        return model.paste(slice, at, options);
      },
      clearMark: () => model.clearClipboardMark(),
    };
  }, []);
}

/** Fill columns with bulk values from a cell (`B2`, `Sheet2!A1`), as opening a file does: no undo step. */
export function useLoad(): (ref: string, columns: readonly (readonly CellValue[])[]) => void {
  const model = useCells();
  return useCallback(
    (ref: string, columns: readonly (readonly CellValue[])[]) => {
      const { sheet, row, col } = resolveCell(model, ref);
      model.loadColumns(sheet, { row, col }, columns);
    },
    [model],
  );
}

/** The model as `CellsWorkbook` JSON, and the values of a zone as rows. */
export function useExport(): {
  toJSON: () => CellsWorkbook;
  toRows: (ref: string) => CellValue[][];
} {
  const model = useCells();
  return useMemo(
    () => ({
      toJSON: () => model.toJSON(),
      toRows: (ref: string) => {
        const { sheet, zone } = resolveRange(model, ref);
        return model.toRows(zone, sheet);
      },
    }),
    [model],
  );
}

/** The Reactor platform the model runs on. */
export function useCellsReactor() {
  return useCells().reactor;
}

/** The Reactor platform's revision: re-renders the caller when plugins or contributions change. */
function useReactorRevision(): number {
  const model = useCells();
  const subscribe = useCallback((notify: () => void) => model.reactor.subscribe(notify), [model]);
  return useSyncExternalStore(
    subscribe,
    () => model.reactor.getRevision(),
    () => model.reactor.getRevision(),
  );
}

/** A plugin: its manifest, whether it is enabled, and the switch. */
export function usePlugin(name: string) {
  const model = useCells();
  const revision = useReactorRevision();
  return useMemo(
    () => ({
      manifest: model.reactor.getManifest(name),
      enabled: model.reactor.isEnabled(name),
      enable: () => model.reactor.enable(name),
      disable: () => model.reactor.disable(name),
    }),
    [model, name, revision],
  );
}

/** Everything contributed to a point, re-read when the platform changes. */
export function useContributions<T>(point: ContributionPoint<T>) {
  const model = useCells();
  const subscribe = useCallback((notify: () => void) => model.reactor.subscribe(notify), [model]);
  const revision = useSyncExternalStore(
    subscribe,
    () => model.reactor.getRevision(),
    () => model.reactor.getRevision(),
  );
  return useMemo(() => model.reactor.getContributions(point), [model, point, revision]);
}

/** The single winner of a one-provider point (none: `undefined`; a tie throws). */
export function useSingleContribution<T>(
  point: ContributionPoint<T>,
  label: string,
  required = false,
): Resolved<T> | undefined {
  const model = useCells();
  useContributions(point);
  return required
    ? firstContribution(model.reactor, point, label)
    : optionalContribution(model.reactor, point, label);
}

/** The Reactor commands (toolbar, menus, palette), with their keybindings. */
export function useCellsCommands(): readonly { id: string; name: string; keybinding?: unknown }[] {
  const model = useCells();
  const subscribe = useCallback((notify: () => void) => model.reactor.subscribe(notify), [model]);
  const revision = useSyncExternalStore(
    subscribe,
    () => model.reactor.getRevision(),
    () => model.reactor.getRevision(),
  );
  return useMemo(
    () => model.reactor.listCommands() as readonly ReactorCommand<unknown, unknown>[],
    [model, revision],
  );
}

/** Run a Reactor command by id. */
export function useExecuteCommand(): <A = void, R = unknown>(
  id: string,
  argument?: A,
) => Promise<R> {
  const model = useCells();
  return useCallback(
    <A, R>(id: string, argument?: A) => model.reactor.executeCommand<A, R>(id, argument),
    [model],
  );
}

/** The model's counters. */
export function useCellsStats() {
  return useDerived((m) => m.stats(), []);
}

/** The command types the model can dispatch (core and plugins). */
export function useCommandTypes(): string[] {
  return useDerived((m) => m.commandTypes(), []);
}

/** Subscribe to every committed change (the `onChange` of a host without `<Spreadsheet>`). */
export function useOnChange(listener: Parameters<CellsModel['subscribe']>[0]): void {
  const model = useCells();
  const ref = useRef(listener);
  ref.current = listener;
  useSyncExternalStore(
    useCallback(
      (notify: () => void) =>
        model.subscribe((tx) => {
          ref.current(tx);
          notify();
        }),
      [model],
    ),
    () => model.revision,
    () => model.revision,
  );
}

/** What `useCharts().insert` takes: a full chart, or a type and a selection to infer its data from. */
export type ChartInsert =
  | (Omit<ChartSpec, 'id'> & { readonly id?: string })
  | {
      readonly type: string;
      /** The selection the data is inferred from (`A1:C13`, `Sheet2!B2:D9`). */
      readonly from: string;
      readonly anchor: ChartAnchor;
      readonly title?: string;
      readonly legend?: ChartSpec['legend'];
    };

/** The charts of a sheet (the active one by default), and the commands on them. */
export function useCharts(sheet?: string): {
  charts: ChartSpec[];
  /** The charts of the sheet still waiting for a pass to settle their cells. */
  pending: string[];
  insert: (chart: ChartInsert) => CommandResult;
  update: (id: string, changes: UpdateChartCommand['changes']) => CommandResult;
  move: (id: string, to: MoveChartCommand['to']) => CommandResult;
  resize: (id: string, to: ResizeChartCommand['to']) => CommandResult;
  remove: (id: string) => CommandResult;
} {
  const model = useCells();
  return useDerived(
    (m) => {
      const id = sheet ?? m.selection.sheet;
      return {
        charts: [...m.sheet(id).charts.values()],
        pending: m
          .chartsPending()
          .filter((c) => c.sheet === id)
          .map((c) => c.id),
        insert: (chart: ChartInsert) => {
          if ('from' in chart) {
            const { sheet: source, zone } = resolveRange(model, chart.from);
            const inferred = inferChartData(
              (r, c) => model.value(source, r, c),
              model.sheet(source).name,
              zone,
            );
            if (!inferred.ok)
              return {
                ok: false,
                refusals: [{ reason: inferred.reason, message: inferred.message }],
              };
            return model.dispatch({
              type: 'INSERT_CHART',
              sheet: id,
              chart: {
                type: chart.type,
                anchor: chart.anchor,
                data: inferred.data,
                legend: chart.legend ?? 'bottom',
                ...(chart.title !== undefined ? { title: chart.title } : {}),
              },
            });
          }
          return model.dispatch({ type: 'INSERT_CHART', sheet: id, chart });
        },
        update: (chart: string, changes: UpdateChartCommand['changes']) =>
          model.dispatch({ type: 'UPDATE_CHART', sheet: id, id: chart, changes }),
        move: (chart: string, to: MoveChartCommand['to']) =>
          model.dispatch({ type: 'MOVE_CHART', sheet: id, id: chart, to }),
        resize: (chart: string, to: ResizeChartCommand['to']) =>
          model.dispatch({ type: 'RESIZE_CHART', sheet: id, id: chart, to }),
        remove: (chart: string) => model.dispatch({ type: 'DELETE_CHART', sheet: id, id: chart }),
      };
    },
    [sheet],
  );
}

/**
 * One chart: its spec (`undefined` once deleted), its data, its point count,
 * and its update. The data is read again only when the chart's data revision
 * moves (once per recalculation slice at most, §3.12) or its spec changes,
 * never on every change of the model.
 */
export function useChart(
  id: string,
  sheet?: string,
): {
  spec: ChartSpec | undefined;
  data: ChartData | undefined;
  /** How many times the data settled: what a drawing memoises on. */
  revision: number;
  points: number;
  update: (changes: UpdateChartCommand['changes']) => CommandResult;
} {
  const model = useCells();
  const sheetId = useDerived((m) => sheet ?? m.selection.sheet, [sheet]);
  const spec = useSyncExternalStore(
    useCallback((notify: () => void) => model.subscribe(notify), [model]),
    () => (model.workbook.hasSheet(sheetId) ? model.sheet(sheetId).charts.get(id) : undefined),
    () => (model.workbook.hasSheet(sheetId) ? model.sheet(sheetId).charts.get(id) : undefined),
  );
  const revision = useSyncExternalStore(
    useCallback((notify: () => void) => model.subscribe(notify), [model]),
    () => model.chartRevision(sheetId, id),
    () => model.chartRevision(sheetId, id),
  );
  return useMemo(
    () => ({
      spec,
      data: spec === undefined ? undefined : model.chartData(sheetId, id),
      revision,
      points: spec === undefined ? 0 : chartPoints(model.workbook, sheetId, spec),
      update: (changes: UpdateChartCommand['changes']) =>
        model.dispatch({ type: 'UPDATE_CHART', sheet: sheetId, id, changes }),
    }),
    [model, sheetId, id, spec, revision],
  );
}
