/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The model: commands in, patches applied, history kept, listeners told.
 * Reading goes through getters; writing only through `dispatch` (and
 * `transact`, `undo`, `redo`). Command handlers and patch ops come from the
 * Reactor platform's `datalayer.cells.*` points, resolved once into tables
 * and again only when the platform changes.
 *
 * @module core/model
 */

import type { ContributionPoint, PlatformInput, ReactorPlatform } from '@datalayer/reactor';
import { type PasteOptions, type Slice, SLICE_VERSION } from './clipboard.js';
import {
  CellsCellTypes,
  CellsClipboard,
  CellsCommands,
  CellsDataSources,
  CellsEditGate,
  CellsFunctions,
  type CellType,
  type CommandHandler,
  type DataSource,
  type FormulaFunction,
  CellsPatchOps,
  CellsRenderLayers,
  PointTable,
  type RenderLayer,
  type Resolved,
} from '../points/index.js';
import {
  type DataSourceError,
  DataSourceStore,
  type DataSourceStats,
  type ResolvedDataSource,
} from './dataSources.js';
import { FormulaEngine } from '../formula/engine.js';
import { type ChartData, chartData, chartRanges, type ChartSpec } from './charts.js';
import type { CellContent } from './cells.js';
import {
  type Command,
  type CommandContext,
  type CommandResult,
  OK,
  parseInput,
  refuse,
} from './commands.js';
import { DEFAULT_HISTORY_LIMITS, type HistoryLimits, LocalHistory } from './history.js';
import type { Patch, PatchOp } from './patches.js';
import { buildCellsReactor, CELLS_CORE_PLUGIN } from './reactor.js';
import { type SelectionState, initialSelection } from './selection.js';
import type { Style } from './styles.js';
import { type CellsWorkbook, loadInto, toJSON, validateWorkbook } from './format.js';
import type { CellValue } from './values.js';
import { DEFAULT_LIMITS, type Limits, type Sheet, Workbook } from './workbook.js';
import { type Position, type Zone, zonesOverlap, zoneToA1 } from './zone.js';

const zoneHelpers = { zonesOverlap, zoneToA1 };

/**
 * Where a change came from. `plugins`: no cell changed, but the formula
 * functions did (a plugin switched on or off), so formulas show other values.
 * `async`: no cell changed, but an asynchronous function's value arrived.
 */
export type Origin =
  | 'local'
  | 'undo'
  | 'redo'
  | 'remote'
  | 'load'
  | 'plugins'
  | 'async'
  | 'charts'
  /** No patches: a data source's page arrived, failed or was evicted (C7-03). */
  | 'source';

/** One committed change: what listeners and `onChange` receive. */
export interface Transaction {
  readonly label: string;
  readonly commands: readonly Command[];
  readonly patches: readonly Patch[];
  readonly origin: Origin;
  /**
   * The charts whose data settled with this change (§3.12): once per
   * recalculation slice, after the slice their cells settled in. A change
   * with no formula pending carries them itself; a pass that runs on in the
   * background sends them later as `origin: 'charts'`, with no patches.
   */
  readonly charts?: readonly { readonly sheet: string; readonly id: string }[];
}

/** What a model is made from: a workbook, a Reactor platform or plugins, limits, read-only, history and data-source limits. */
export interface CellsModelOptions {
  /** A started Reactor platform the host owns, with `CellsCorePlugin` among its plugins. */
  readonly reactor?: ReactorPlatform;
  /** Reactor plugins: the model builds its own platform from the core, the built-ins and these. */
  readonly plugins?: readonly PlatformInput[];
  readonly limits?: Partial<Limits>;
  readonly readOnly?: boolean;
  readonly history?: Partial<HistoryLimits>;
  /** A `CellsWorkbook` to load; validated whole first, refused with the path of the first bad field. */
  readonly data?: unknown;
  /** Data sources (C7-03): how many pages of 1,024 rows stay resident across the workbook; 256 by default. */
  readonly dataSources?: { readonly pages?: number };
}

/** Called with each committed change. */
export type ChangeListener = (transaction: Transaction) => void;

/** A cell being edited: where, and the text of the edit buffer (the in-cell editor and a formula bar share it). */
export interface EditState {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  readonly text: string;
}

/** Called when the edit starts, its text changes, or it ends (`null`). */
export type EditListener = (edit: EditState | null) => void;

/** The zone last copied or cut: what the marching ants surround. */
export interface ClipboardMark {
  readonly sheet: string;
  readonly zone: Zone;
  readonly cut: boolean;
}
/** Called with each new selection. */
export type SelectionListener = (selection: SelectionState) => void;

/** A remote peer's presence (§3.9): who, where, and what it is doing; view state the overlay draws. */
export interface RemotePeer {
  /** The peer's client id in the room. */
  readonly id: string;
  readonly user: { readonly name: string; readonly color: string };
  readonly sheet: string;
  readonly zones: readonly Zone[];
  readonly active: Position;
  /** The cell the peer is editing, if any. */
  readonly editing?: Position;
  /** The chart the peer selected, if any. */
  readonly chart?: string;
}

/** The headless spreadsheet (§3.1): commands in through `dispatch`, patches applied, history kept, listeners told; no React, no DOM. */
export class CellsModel {
  readonly reactor: ReactorPlatform;
  readonly workbook: Workbook;
  readonly readOnly: boolean;
  readonly #commands: PointTable<CommandHandler<any>>;
  readonly #patchOps: PointTable<PatchOp<any>>;
  readonly #functions: PointTable<FormulaFunction>;
  readonly #cellTypes: PointTable<CellType>;
  readonly #dataSources: PointTable<DataSource>;
  readonly #renderLayers: PointTable<RenderLayer>;
  readonly #sourceStore: DataSourceStore;
  readonly #sourceErrorListeners = new Set<(error: DataSourceError) => void>();
  readonly #engine: FormulaEngine;
  readonly #history: LocalHistory<SelectionState>;
  readonly #listeners = new Set<ChangeListener>();
  readonly #selectionListeners = new Set<SelectionListener>();
  readonly #presenceListeners = new Set<(peers: readonly RemotePeer[]) => void>();
  readonly #editListeners = new Set<EditListener>();
  #edit: EditState | null = null;
  #mark: ClipboardMark | null = null;
  /** The selected chart's id (§3.12), view state beside the cell selection; selecting cells clears it. */
  #selectedChart: string | null = null;
  /** The other peers of the room, as the collaboration provider reports them (§3.9). */
  #remotePresence: readonly RemotePeer[] = [];
  #revision = 0;
  #selection: SelectionState;
  /** Charts settled while patches were being applied: announced with the change that applied them. */
  #settledCharts: { sheet: string; id: string }[] = [];
  #applying = false;
  /** The open transaction, while `transact` runs. */
  #open: {
    label: string;
    commands: Command[];
    patches: Patch[];
    selectionBefore: SelectionState;
  } | null = null;

  constructor(options: CellsModelOptions = {}) {
    if (options.reactor !== undefined && options.plugins !== undefined) {
      throw new Error('Pass a Reactor platform or plugins to build one from, not both.');
    }
    if (options.reactor !== undefined && !options.reactor.hasPlugin(CELLS_CORE_PLUGIN)) {
      throw new Error(
        `The Reactor platform has no ${CELLS_CORE_PLUGIN}: add CellsCorePlugin to its plugins.`,
      );
    }
    this.reactor = options.reactor ?? buildCellsReactor(options.plugins ?? []);
    this.readOnly = options.readOnly ?? false;
    this.workbook = new Workbook({ ...DEFAULT_LIMITS, ...options.limits });
    this.#history = new LocalHistory({ ...DEFAULT_HISTORY_LIMITS, ...options.history });
    this.#commands = new PointTable(this.reactor, CellsCommands, {
      label: 'command',
      key: (h) => h.type,
      check: (h) => {
        if (typeof h.type !== 'string' || h.type === '')
          throw new Error('a command handler has a type');
        if (typeof h.apply !== 'function') throw new Error(`the command ${h.type} has no apply`);
      },
    });
    this.#patchOps = new PointTable(this.reactor, CellsPatchOps, {
      label: 'patch op',
      key: (op) => op.op,
      check: (op) => {
        for (const f of ['apply', 'invert', 'example'] as const) {
          if (typeof op[f] !== 'function') throw new Error(`the patch op '${op.op}' has no ${f}`);
        }
      },
    });
    this.#functions = new PointTable(this.reactor, CellsFunctions, {
      label: 'function',
      key: (f) => f.name,
      check: (f) => {
        if (typeof f.name !== 'string' || !/^[A-Z][A-Z0-9._]*$/.test(f.name))
          throw new Error(`a function is named in upper case, as typed: '${String(f.name)}'`);
        if (typeof f.compute !== 'function')
          throw new Error(`the function ${f.name} has no compute`);
      },
    });
    this.#cellTypes = new PointTable(this.reactor, CellsCellTypes, {
      label: 'cell type',
      key: (t) => t.id,
      check: (t) => {
        if (typeof t.id !== 'string' || t.id === '') throw new Error('a cell type has an id');
        if (typeof t.render !== 'function')
          throw new Error(`the cell type '${t.id}' has no render`);
        if (t.activateOn !== undefined && !Array.isArray(t.activateOn))
          throw new Error(`the cell type '${t.id}' lists the keys that activate it in activateOn`);
      },
    });
    this.#dataSources = new PointTable(this.reactor, CellsDataSources, {
      label: 'data source',
      key: (d) => d.id,
      check: (d) => {
        if (typeof d.id !== 'string' || d.id === '') throw new Error('a data source has an id');
        if (!(Number.isInteger(d.rowCount) && d.rowCount >= 0))
          throw new Error(`the data source '${d.id}' has a rowCount, a non-negative integer`);
        if (!Array.isArray(d.columns))
          throw new Error(`the data source '${d.id}' lists its columns`);
        if (typeof d.fetch !== 'function')
          throw new Error(`the data source '${d.id}' has no fetch`);
      },
    });
    this.#renderLayers = new PointTable(this.reactor, CellsRenderLayers, {
      label: 'render layer',
      key: (l) => l.id,
      check: (l) => {
        if (typeof l.id !== 'string' || l.id === '') throw new Error('a render layer has an id');
        if (!['background', 'cells', 'overlay'].includes(l.layer))
          throw new Error(`the render layer '${l.id}' draws on background, cells or overlay`);
        if (typeof l.draw !== 'function') throw new Error(`the render layer '${l.id}' has no draw`);
      },
    });
    const dataSources = this.#dataSources;
    this.#sourceStore = new DataSourceStore(
      this.workbook,
      {
        get revision() {
          return dataSources.revision;
        },
        get: (id) => dataSources.get(id),
      },
      {
        pages: options.dataSources?.pages,
        onWritten: (sheet, zone) => {
          this.#engine.written(sheet, zone);
          this.#emit({ label: 'source', commands: [], patches: [], origin: 'source' });
        },
        onError: (error) => {
          for (const l of [...this.#sourceErrorListeners]) l(error);
        },
      },
    );
    const functions = this.#functions;
    const sourceStore = this.#sourceStore;
    this.#engine = new FormulaEngine(
      this.workbook,
      {
        get revision() {
          return functions.revision;
        },
        get: (name) => functions.get(name)?.value,
      },
      {
        sources: sourceStore,
        onSettled: () => this.#emit({ label: 'async', commands: [], patches: [], origin: 'async' }),
        chartRanges: (sheet, spec) => chartRanges(this.workbook, sheet, spec as ChartSpec),
        onCharts: (charts) => {
          if (this.#applying || this.#open !== null) this.#settledCharts.push(...charts);
          else this.#emit({ label: 'charts', commands: [], patches: [], origin: 'charts', charts });
        },
      },
    );
    // Resolved now, so two plugins contributing one function name (or cell type id) are refused at once, by name.
    functions.keys();
    this.#cellTypes.keys();
    this.#dataSources.keys();
    this.#renderLayers.keys();
    if (options.data !== undefined) {
      loadInto(this.workbook, options.data);
      // Values a file carries for its formulas are recomputed, not trusted.
      this.#engine.reset();
    } else this.workbook.sheets.push(this.workbook.createSheet('Sheet1'));
    if (this.workbook.sheets.length === 0) throw new Error('A workbook holds at least one sheet.');
    this.#selection = initialSelection(this.workbook.sheets[0].id);
    let known = this.#functions.all().map((r) => r.value);
    let knownTypes = this.#cellTypes.all().map((r) => r.value);
    let knownLayers = this.renderLayers();
    this.reactor.subscribe(() => {
      const now = this.#functions.all().map((r) => r.value);
      const types = this.#cellTypes.all().map((r) => r.value);
      const layers = this.renderLayers();
      const sameFunctions = now.length === known.length && now.every((f, i) => f === known[i]);
      const sameLayers =
        layers.length === knownLayers.length && layers.every((l, i) => l === knownLayers[i]);
      // Layers count as "types" below: either way, every cell repaints.
      const sameTypes =
        types.length === knownTypes.length &&
        types.every((t, i) => t === knownTypes[i]) &&
        sameLayers;
      knownLayers = layers;
      // A bound sheet whose source came or went drops its pages (the store compares on resolve).
      let sourcesMoved = false;
      for (const sheet of this.workbook.sheets) {
        if (sheet.dataSource === null) continue;
        const before = this.#sourceStore.stats.resident + this.#sourceStore.stats.loading;
        this.#sourceStore.resolve(sheet.id);
        if (this.#sourceStore.stats.resident + this.#sourceStore.stats.loading !== before)
          sourcesMoved = true;
      }
      if (sameFunctions && sameTypes && !sourcesMoved) return;
      known = now;
      knownTypes = types;
      // Formulas show other values, or typed cells draw otherwise: the view reads everything again.
      if ((!sameFunctions && this.workbook.formulas.size > 0) || !sameTypes || sourcesMoved)
        this.#emit({ label: 'plugins', commands: [], patches: [], origin: 'plugins' });
    });
  }

  // ---------------------------------------------------------------- writing

  /** Run a command: refused with reasons, or applied as one undo step (or into the open transaction). */
  dispatch(command: Command): CommandResult {
    if (this.readOnly) return refuse('ReadOnly', 'The workbook is read-only.');
    const handler = this.#commands.get(command.type);
    if (handler === undefined) {
      return refuse('UnknownCommand', `No plugin handles the command '${command.type}'.`);
    }
    const context = this.#context();
    const allowed = handler.value.allow ? handler.value.allow(context, command) : OK;
    if (!allowed.ok) return allowed;
    const verdict = this.reactor.checkGate(CellsEditGate, { command, context });
    if (!verdict.allowed) {
      return refuse(
        'Gate',
        verdict.reason ?? `${verdict.blockedBy ?? 'A plugin'} refused ${command.type}.`,
      );
    }
    const patches = handler.value.apply(context, command);
    // A bound data source's zone is read, never written: a command reaching into it is refused whole.
    const blocked = this.#sourceStore.refuses(patches);
    if (blocked !== undefined) return blocked;
    this.#applyAll(patches);
    if (this.#open) {
      this.#open.commands.push(command);
      this.#open.patches.push(...patches);
    } else {
      this.#commit(command.type, [command], patches, this.#selection);
    }
    return OK;
  }

  /**
   * Group every command `fn` dispatches into one undo step and one change
   * event. If `fn` throws, what it applied is rolled back and the error rethrown.
   * A refused command inside does not stop the others; `fn` decides.
   */
  transact<T>(label: string, fn: () => T): T {
    if (this.#open) return fn(); // nested: part of the outer transaction
    this.#open = { label, commands: [], patches: [], selectionBefore: this.#selection };
    let result: T;
    try {
      result = fn();
    } catch (error) {
      const open = this.#open;
      this.#open = null;
      this.#applyAll(this.#inverses(open.patches));
      throw error;
    }
    const open = this.#open;
    this.#open = null;
    if (open.patches.length > 0)
      this.#commit(label, open.commands, open.patches, open.selectionBefore);
    return result;
  }

  undo(): boolean {
    if (this.#open) throw new Error('Cannot undo inside a transaction.');
    const step = this.#history.popUndo();
    if (step === undefined) return false;
    const inverses = this.#inverses(step.patches);
    this.#applyAll(inverses);
    this.#setSelection(this.#validSelection(step.selectionBefore));
    this.#emit({ label: step.label, commands: [], patches: inverses, origin: 'undo' });
    return true;
  }

  redo(): boolean {
    if (this.#open) throw new Error('Cannot redo inside a transaction.');
    const step = this.#history.popRedo();
    if (step === undefined) return false;
    this.#applyAll(step.patches);
    this.#setSelection(this.#validSelection(step.selectionAfter));
    this.#emit({ label: step.label, commands: [], patches: step.patches, origin: 'redo' });
    return true;
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  /** The labels of the steps undo and redo would take. */
  get historyLabels(): { undo?: string; redo?: string } {
    return { undo: this.#history.undoLabel, redo: this.#history.redoLabel };
  }

  /**
   * Replace the whole workbook with a `CellsWorkbook` (validated whole first):
   * no patches and no undo step, the history cleared, the selection kept
   * where it still exists. A collaboration binding projects its shared
   * document this way (`origin: 'remote'`); opening a file in place is a load.
   */
  replaceData(data: unknown, origin: 'remote' | 'load' = 'load'): void {
    if (this.#open) throw new Error('Cannot replace the workbook inside a transaction.');
    // Validated before anything is dropped: a bad document leaves the workbook as it was.
    validateWorkbook(data, this.workbook.limits);
    for (const sheet of this.workbook.sheets)
      for (const [row, col] of [...sheet.cells.entries()]) sheet.cells.set(row, col, null);
    this.workbook.sheets.length = 0;
    this.#sourceStore.forgetAll();
    loadInto(this.workbook, data);
    this.#engine.reset();
    this.#history.clear();
    if (this.#edit !== null && !this.workbook.hasSheet(this.#edit.sheet)) this.#setEdit(null);
    this.#setSelection(this.#validSelection(this.#selection));
    this.#emit({ label: origin, commands: [], patches: [], origin });
  }

  /**
   * Fill columns of values from a cell, as opening a file does: straight into
   * the store, with no patches and no undo step, and the history cleared (its
   * steps no longer describe the workbook). For bulk data a person did not type;
   * edits go through `dispatch`.
   */
  loadColumns(
    sheet: string,
    at: Position,
    columns: readonly (readonly CellValue[])[],
    /** A number format per cell (`undefined`: the cell keeps its style), as a file's dates and percentages ask. */
    formats?: readonly (readonly (string | undefined)[])[],
  ): void {
    if (this.#open) throw new Error('Cannot load inside a transaction.');
    const s = this.workbook.sheet(sheet);
    let height = 0;
    for (const c of columns) if (c.length > height) height = c.length;
    if (
      at.row < 0 ||
      at.col < 0 ||
      at.row + height > s.rows.count ||
      at.col + columns.length > s.cols.count
    ) {
      throw new Error(
        `${columns.length} columns of ${height} rows at ${at.row},${at.col} do not fit sheet '${sheet}'.`,
      );
    }
    const bound = this.#sourceStore.zoneOf(sheet);
    if (bound !== undefined) {
      const zone = {
        top: at.row,
        left: at.col,
        bottom: at.row + height - 1,
        right: at.col + columns.length - 1,
      };
      const { zonesOverlap, zoneToA1 } = zoneHelpers;
      if (zonesOverlap(bound, zone))
        throw new Error(
          `${zoneToA1(zone)} reaches ${zoneToA1(bound)}, which shows the data source '${s.dataSource!.id}' and cannot be loaded into.`,
        );
    }
    const styleOf = new Map<string, number>();
    columns.forEach((values, dc) => {
      const col = at.col + dc;
      const columnFormats = formats?.[dc];
      for (let i = 0; i < values.length; i += 1) {
        const v = values[i];
        const format = columnFormats?.[i];
        let style: number;
        if (format !== undefined) {
          let k = styleOf.get(format);
          if (k === undefined) {
            k = this.workbook.styles.intern({ format });
            styleOf.set(format, k);
          }
          style = k;
        } else style = s.cells.styleAt(at.row + i, col);
        s.cells.set(at.row + i, col, v === null && style === 0 ? null : { value: v, style });
      }
    });
    this.#history.clear();
    this.#emit({ label: 'load', commands: [], patches: [], origin: 'load' });
  }

  // ---------------------------------------------------------------- listening

  /** Called after every committed change; returns the unsubscriber. */
  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The selection stream: called on every selection change. */
  subscribeSelection(listener: SelectionListener): () => void {
    this.#selectionListeners.add(listener);
    return () => this.#selectionListeners.delete(listener);
  }

  /** Grows on every change: what `useSyncExternalStore` compares. */
  get revision(): number {
    return this.#revision;
  }

  // ---------------------------------------------------------------- selection

  get selection(): SelectionState {
    return this.#selection;
  }

  /** Set the selection (view state: never undone, never synced). */
  select(selection: SelectionState): void {
    if (!this.workbook.hasSheet(selection.sheet))
      throw new Error(`No sheet '${selection.sheet}' to select in.`);
    if (selection.zones.length === 0) throw new Error('A selection holds at least one zone.');
    this.#setSelection(selection);
  }

  /** The remote peers' presence: view state, drawn on the overlay, never undone. */
  get remotePresence(): readonly RemotePeer[] {
    return this.#remotePresence;
  }

  /** What the collaboration provider reports of the other peers; the presence listeners (the overlay) hear it. */
  setRemotePresence(peers: readonly RemotePeer[]): void {
    this.#remotePresence = peers;
    this.#revision += 1;
    for (const l of [...this.#presenceListeners]) l(peers);
  }

  /** Called when the remote peers' presence changes; returns the unsubscriber. */
  subscribePresence(listener: (peers: readonly RemotePeer[]) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  /** The selected chart's id on the selection's sheet, or `null`: view state, never synced. */
  get selectedChart(): string | null {
    return this.#selectedChart;
  }

  /** Select a chart of the selection's sheet (the keyboard then moves it), or none. */
  selectChart(id: string | null): void {
    if (id !== null && !this.workbook.sheet(this.#selection.sheet).charts.has(id))
      throw new Error(`No chart '${id}' on sheet '${this.#selection.sheet}'.`);
    if (id === this.#selectedChart) return;
    this.#selectedChart = id;
    this.#revision += 1;
    for (const l of [...this.#selectionListeners]) l(this.#selection);
  }

  // ---------------------------------------------------------------- clipboard

  /** The zone last copied or cut, for the marching ants; view state. */
  get clipboardMark(): ClipboardMark | null {
    return this.#mark;
  }

  /**
   * Copy a zone (the selection's last by default): each clipboard handler's
   * part. `cut` marks it to be cleared when the slice is pasted.
   */
  copy(zone?: Zone, options: { cut?: boolean; sheet?: string } = {}): Slice {
    const sheet = options.sheet ?? this.#selection.sheet;
    const z = zone ?? this.#selection.zones[this.#selection.zones.length - 1];
    const context = this.#context();
    const parts: Record<string, unknown> = {};
    for (const handler of context.contributions(CellsClipboard)) {
      const part = handler.copy(context, sheet, z);
      if (part !== undefined) parts[handler.id] = part;
    }
    const cut = options.cut === true;
    this.#setMark({ sheet, zone: z, cut });
    return {
      version: SLICE_VERSION,
      rows: z.bottom - z.top + 1,
      cols: z.right - z.left + 1,
      source: { sheet, zone: z, cut },
      parts,
    };
  }

  /**
   * Paste a slice at a cell (the active cell by default), as one undo step. A
   * cut slice from this model moves: its source is cleared in the same step.
   */
  paste(
    slice: Slice,
    at?: { row: number; col: number },
    options: PasteOptions = {},
  ): CommandResult {
    const sheet = this.#selection.sheet;
    const target = at ?? this.#selection.active;
    const mark = this.#mark;
    const moving =
      slice.source?.cut === true &&
      mark !== null &&
      mark.cut &&
      mark.sheet === slice.source.sheet &&
      JSON.stringify(mark.zone) === JSON.stringify(slice.source.zone) &&
      this.workbook.hasSheet(slice.source.sheet);
    const command = { type: 'PASTE', sheet, at: target, slice, options } as const;
    // Refused before anything moves: a cut's source is cleared only for a paste that will land.
    const handler = this.#commands.get('PASTE');
    if (handler === undefined)
      return refuse('UnknownCommand', 'No plugin handles PASTE: add CellsClipboardPlugin.');
    const allowed = handler.value.allow ? handler.value.allow(this.#context(), command) : OK;
    if (!allowed.ok) return allowed;
    const result = this.transact(moving ? 'Move' : 'Paste', () => {
      if (moving) {
        const cleared = this.dispatch({
          type: 'CLEAR',
          sheet: slice.source!.sheet,
          zone: slice.source!.zone,
        });
        if (!cleared.ok) return cleared;
      }
      return this.dispatch(command);
    });
    if (moving && result.ok) this.#setMark(null);
    return result;
  }

  /** Forget the marching ants (Escape). */
  clearClipboardMark(): void {
    this.#setMark(null);
  }

  #setMark(mark: ClipboardMark | null): void {
    this.#mark = mark;
    this.#revision += 1;
    for (const l of [...this.#selectionListeners]) l(this.#selection);
  }

  #context(): CommandContext {
    return {
      workbook: this.workbook,
      value: (sheet, row, col) => this.#engine.value(sheet, row, col),
      contributions: <T>(point: ContributionPoint<T>) =>
        this.reactor.getContributions(point).map((c) => c.value),
    };
  }

  // ---------------------------------------------------------------- editing

  /** The cell being edited and its buffer, or `null`. View state: never undone, never synced. */
  get edit(): EditState | null {
    return this.#edit;
  }

  /**
   * Start editing a cell (the active cell by default). Without `text`, the
   * buffer starts with what the cell holds (its formula with `=`, or its value
   * as typed); with it, the buffer is replaced, as typing over a cell does.
   */
  startEdit(at?: { row: number; col: number }, text?: string): void {
    if (this.readOnly) throw new Error('The workbook is read-only: nothing can be edited.');
    const sheet = this.#selection.sheet;
    const cell = at ?? this.#selection.active;
    const s = this.workbook.sheet(sheet);
    if (cell.row < 0 || cell.col < 0 || cell.row >= s.rows.count || cell.col >= s.cols.count) {
      throw new Error(`No cell ${cell.row},${cell.col} to edit in '${sheet}'.`);
    }
    this.#setEdit({
      sheet,
      row: cell.row,
      col: cell.col,
      text: text ?? this.#editText(sheet, cell.row, cell.col),
    });
  }

  /** Replace the edit buffer's text. */
  setEditText(text: string): void {
    if (this.#edit === null) throw new Error('No cell is being edited.');
    if (text === this.#edit.text) return;
    this.#setEdit({ ...this.#edit, text });
  }

  /**
   * Write the buffer into its cell, as typing it would (a formula for `=…`, a
   * number, a boolean, else text). A refusal keeps the edit open and comes
   * back with its reasons.
   */
  commitEdit(): CommandResult {
    const edit = this.#edit;
    if (edit === null) throw new Error('No cell is being edited.');
    const result = this.dispatch({
      type: 'SET_CELLS',
      sheet: edit.sheet,
      at: { row: edit.row, col: edit.col },
      cells: [[parseInput(edit.text)]],
    });
    if (result.ok) this.#setEdit(null);
    return result;
  }

  /** Leave the cell as it was. */
  cancelEdit(): void {
    if (this.#edit !== null) this.#setEdit(null);
  }

  /** Called on every change to the edit (start, text, end). */
  subscribeEdit(listener: EditListener): () => void {
    this.#editListeners.add(listener);
    return () => this.#editListeners.delete(listener);
  }

  #editText(sheet: string, row: number, col: number): string {
    const c = this.workbook.sheet(sheet).cells.get(row, col);
    if (c === null) return '';
    if (c.formula !== undefined) return `=${c.formula}`;
    const v = c.value;
    if (v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'object') return v.error;
    if (typeof v === 'string' && (v.startsWith('=') || parseInput(v) !== v)) return `'${v}`;
    return String(v);
  }

  #setEdit(edit: EditState | null): void {
    this.#edit = edit;
    this.#revision += 1;
    for (const l of [...this.#editListeners]) l(edit);
  }

  // ---------------------------------------------------------------- reading

  get sheets(): readonly Sheet[] {
    return this.workbook.sheets;
  }

  sheet(id: string): Sheet {
    return this.workbook.sheet(id);
  }

  /** What a cell holds, or `null`. */
  content(sheet: string, row: number, col: number): CellContent | null {
    return this.workbook.sheet(sheet).cells.get(row, col);
  }

  /** What a cell shows: its value, or its formula evaluated (on read, memoised until the next change). */
  value(sheet: string, row: number, col: number): CellValue {
    return this.#engine.value(sheet, row, col);
  }

  /** The formula functions plugins contribute, by name. */
  functionNames(): string[] {
    return [...this.#functions.keys()].sort();
  }

  /** A formula function by its upper-case name, or `undefined`. */
  formulaFunction(name: string): FormulaFunction | undefined {
    return this.#functions.get(name)?.value;
  }

  style(sheet: string, row: number, col: number): Style {
    const c = this.content(sheet, row, col);
    return this.workbook.styles.get(c?.style ?? 0);
  }

  /**
   * The cell type a cell is drawn and edited with (§3.11): the contribution
   * its style's `type` names, with the plugin that contributes it; `undefined`
   * for a cell with no type, or whose type no enabled plugin contributes (it
   * then draws as a plain value).
   */
  cellType(sheet: string, row: number, col: number): Resolved<CellType> | undefined {
    const type = this.style(sheet, row, col).type;
    return type === undefined ? undefined : this.#cellTypes.get(type);
  }

  /** A cell type by its id, or `undefined`. */
  cellTypeOf(id: string): Resolved<CellType> | undefined {
    return this.#cellTypes.get(id);
  }

  /** The ids of the cell types plugins contribute, sorted. */
  cellTypeIds(): string[] {
    return [...this.#cellTypes.keys()].sort();
  }

  /** The render layers plugins contribute (§3.3), in `order`; the renderer draws them after the core layer of their kind. */
  renderLayers(): readonly RenderLayer[] {
    return this.#renderLayers.all().map((r) => r.value);
  }

  /**
   * A sheet's data source (C7-03): its binding and zone, the contribution
   * when an enabled plugin provides it with the bound shape, else the
   * sentence its cells show; `undefined` for a sheet bound to none.
   */
  dataSource(sheet: string): ResolvedDataSource | undefined {
    return this.#sourceStore.resolve(sheet);
  }

  /** The ids of the data sources plugins contribute, sorted. */
  dataSourceIds(): string[] {
    return [...this.#dataSources.keys()].sort();
  }

  /** A data source by its id, or `undefined`. */
  dataSourceOf(id: string): Resolved<DataSource> | undefined {
    return this.#dataSources.get(id);
  }

  /** The page cache: pages resident, loading and failed, fetches and evictions so far, and the capacity. */
  dataSourceStats(): DataSourceStats & { capacity: number } {
    return { ...this.#sourceStore.stats, capacity: this.#sourceStore.capacity };
  }

  /** Drop a sheet's pages, failed ones included: they are read again on demand. */
  refreshDataSource(sheet: string): void {
    this.workbook.sheet(sheet);
    this.#sourceStore.forget(sheet);
  }

  /** Called when a data source's page fails (`onDataSourceError`); returns the unsubscriber. */
  subscribeDataSourceErrors(listener: (error: DataSourceError) => void): () => void {
    this.#sourceErrorListeners.add(listener);
    return () => this.#sourceErrorListeners.delete(listener);
  }

  /**
   * How many times a chart's data settled (§3.12): what a drawing memoises
   * on, with the spec. It moves once per recalculation slice at most, after
   * the slice the chart's cells settled in; a change with no formula pending
   * moves it at once. 0 for a chart the model does not hold.
   */
  chartRevision(sheet: string, id: string): number {
    return this.#engine.chartRevision(sheet, id);
  }

  /** The charts marked by a pass still running: waiting for their cells. */
  chartsPending(): { sheet: string; id: string }[] {
    return this.#engine.markedCharts();
  }

  /** The data a chart draws, read now (a cell still being fetched is a gap). */
  chartData(sheet: string, id: string): ChartData {
    const spec = this.workbook.sheet(sheet).charts.get(id);
    if (spec === undefined) throw new Error(`No chart '${id}' on sheet '${sheet}'.`);
    return chartData((s, r, c) => this.value(s, r, c), this.workbook, sheet, spec);
  }

  /** The workbook as `CellsWorkbook` JSON. */
  toJSON(): CellsWorkbook {
    return toJSON(this.workbook);
  }

  /** The values a zone shows, as rows (empty cells are `null`). */
  toRows(zone: Zone, sheet: string = this.#selection.sheet): CellValue[][] {
    const s = this.workbook.sheet(sheet);
    if (
      zone.bottom >= s.rows.count ||
      zone.right >= s.cols.count ||
      zone.top < 0 ||
      zone.left < 0
    ) {
      throw new Error(`The zone reaches outside sheet '${sheet}'.`);
    }
    const rows: CellValue[][] = [];
    for (let r = zone.top; r <= zone.bottom; r += 1) {
      const row: CellValue[] = [];
      for (let c = zone.left; c <= zone.right; c += 1) row.push(this.value(sheet, r, c));
      rows.push(row);
    }
    return rows;
  }

  /** Counters for the debug overlay and `useCellsStats`. */
  stats(): {
    revision: number;
    sheets: number;
    cells: number;
    chunks: number;
    strings: number;
    styles: number;
    formulas: number;
    /** The formula engine: shapes compiled (and compilations run), cells parsed, values memoised. */
    engine: ReturnType<FormulaEngine['stats']>;
    history: { steps: number; bytes: number };
  } {
    let cells = 0;
    let chunks = 0;
    for (const s of this.workbook.sheets) {
      cells += s.cells.filled;
      chunks += s.cells.chunkCount;
    }
    return {
      revision: this.#revision,
      sheets: this.workbook.sheets.length,
      cells,
      chunks,
      strings: this.workbook.strings.size,
      styles: this.workbook.styles.size,
      formulas: this.workbook.formulas.size,
      engine: this.#engine.stats(),
      history: this.#history.size,
    };
  }

  /** The handler of a command type, for hosts that list what can be dispatched. */
  commandTypes(): string[] {
    return [...this.#commands.keys()];
  }

  /** The patch op of a type; the forcing test reads it. */
  patchOp(op: string): PatchOp<any> | undefined {
    return this.#patchOps.get(op)?.value;
  }

  patchOpNames(): string[] {
    return [...this.#patchOps.keys()];
  }

  // ---------------------------------------------------------------- internals

  #applyAll(patches: readonly Patch[]): void {
    const applied: Patch[] = [];
    this.#applying = true;
    try {
      for (const p of patches) {
        const op = this.#patchOps.get(p.op);
        if (op === undefined) throw new Error(`No plugin registers the patch op '${p.op}'.`);
        this.#engine.willApply(p);
        this.#sourceStore.willApply(p);
        op.value.apply(this.workbook, p);
        this.#engine.applied(p);
        applied.push(p);
      }
      this.#engine.flush();
    } catch (error) {
      this.#engine.reset();
      // Leave the workbook as it was: undo what this batch applied, then fail loudly.
      for (const p of this.#inverses(applied))
        this.#patchOps.get(p.op)!.value.apply(this.workbook, p);
      throw error;
    } finally {
      this.#applying = false;
    }
  }

  /** The inverses of patches, in reverse order. */
  #inverses(patches: readonly Patch[]): Patch[] {
    const out: Patch[] = [];
    for (let i = patches.length - 1; i >= 0; i -= 1) {
      const op = this.#patchOps.get(patches[i].op);
      if (op === undefined) throw new Error(`No plugin registers the patch op '${patches[i].op}'.`);
      out.push(op.value.invert(patches[i]));
    }
    return out;
  }

  #commit(
    label: string,
    commands: readonly Command[],
    patches: readonly Patch[],
    selectionBefore: SelectionState,
  ): void {
    if (patches.length === 0) return;
    const selectionAfter = this.#validSelection(this.#selection);
    if (selectionAfter !== this.#selection) this.#setSelection(selectionAfter);
    let bytes = 0;
    for (const p of patches) bytes += this.#patchOps.get(p.op)?.value.bytes?.(p) ?? 256;
    this.#history.push({ label, patches, bytes, selectionBefore, selectionAfter });
    this.#emit({ label, commands, patches, origin: 'local' });
  }

  /** A selection still valid after a change: its sheet may have gone. */
  #validSelection(s: SelectionState): SelectionState {
    return this.workbook.hasSheet(s.sheet) ? s : initialSelection(this.workbook.sheets[0].id);
  }

  #setSelection(s: SelectionState): void {
    if (s === this.#selection) return;
    this.#selection = s;
    this.#selectedChart = null;
    this.#revision += 1;
    for (const l of [...this.#selectionListeners]) l(s);
  }

  #emit(tx: Transaction): void {
    if (tx.origin === 'load') this.#engine.reset();
    if (this.#edit !== null && !this.workbook.hasSheet(this.#edit.sheet)) this.#setEdit(null);
    if (
      this.#selectedChart !== null &&
      !(
        this.workbook.hasSheet(this.#selection.sheet) &&
        this.workbook.sheet(this.#selection.sheet).charts.has(this.#selectedChart)
      )
    )
      this.#selectedChart = null;
    if (this.#settledCharts.length > 0 && this.#open === null) {
      tx = { ...tx, charts: [...(tx.charts ?? []), ...this.#settledCharts] };
      this.#settledCharts = [];
    }
    this.#revision += 1;
    for (const l of [...this.#listeners]) l(tx);
  }
}

/** A model: from `data` (a `CellsWorkbook`), or one empty sheet. */
export function createCellsModel(options: CellsModelOptions = {}): CellsModel {
  return new CellsModel(options);
}
