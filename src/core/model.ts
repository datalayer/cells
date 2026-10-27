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
  CellsClipboard,
  CellsCommands,
  CellsEditGate,
  CellsFunctions,
  type CommandHandler,
  type FormulaFunction,
  CellsPatchOps,
  PointTable,
} from '../points/index.js';
import { FormulaEngine } from '../formula/engine.js';
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
import type { Position, Zone } from './zone.js';

/**
 * Where a change came from. `plugins`: no cell changed, but the formula
 * functions did (a plugin switched on or off), so formulas show other values.
 * `async`: no cell changed, but an asynchronous function's value arrived.
 */
export type Origin = 'local' | 'undo' | 'redo' | 'remote' | 'load' | 'plugins' | 'async';

/** One committed change: what listeners and `onChange` receive. */
export interface Transaction {
  readonly label: string;
  readonly commands: readonly Command[];
  readonly patches: readonly Patch[];
  readonly origin: Origin;
}

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
}

export type ChangeListener = (transaction: Transaction) => void;

/** A cell being edited: where, and the text of the edit buffer (the in-cell editor and a formula bar share it). */
export interface EditState {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  readonly text: string;
}

export type EditListener = (edit: EditState | null) => void;

/** The zone last copied or cut: what the marching ants surround. */
export interface ClipboardMark {
  readonly sheet: string;
  readonly zone: Zone;
  readonly cut: boolean;
}
export type SelectionListener = (selection: SelectionState) => void;

export class CellsModel {
  readonly reactor: ReactorPlatform;
  readonly workbook: Workbook;
  readonly readOnly: boolean;
  readonly #commands: PointTable<CommandHandler<any>>;
  readonly #patchOps: PointTable<PatchOp<any>>;
  readonly #functions: PointTable<FormulaFunction>;
  readonly #engine: FormulaEngine;
  readonly #history: LocalHistory<SelectionState>;
  readonly #listeners = new Set<ChangeListener>();
  readonly #selectionListeners = new Set<SelectionListener>();
  readonly #editListeners = new Set<EditListener>();
  #edit: EditState | null = null;
  #mark: ClipboardMark | null = null;
  #revision = 0;
  #selection: SelectionState;
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
    const functions = this.#functions;
    this.#engine = new FormulaEngine(
      this.workbook,
      {
        get revision() {
          return functions.revision;
        },
        get: (name) => functions.get(name)?.value,
      },
      {
        onSettled: () => this.#emit({ label: 'async', commands: [], patches: [], origin: 'async' }),
      },
    );
    // Resolved now, so two plugins contributing one function name are refused at once, by name.
    functions.keys();
    if (options.data !== undefined) {
      loadInto(this.workbook, options.data);
      // Values a file carries for its formulas are recomputed, not trusted.
      this.#engine.reset();
    } else this.workbook.sheets.push(this.workbook.createSheet('Sheet1'));
    if (this.workbook.sheets.length === 0) throw new Error('A workbook holds at least one sheet.');
    this.#selection = initialSelection(this.workbook.sheets[0].id);
    let known = this.#functions.all().map((r) => r.value);
    this.reactor.subscribe(() => {
      const now = this.#functions.all().map((r) => r.value);
      if (now.length === known.length && now.every((f, i) => f === known[i])) return;
      known = now;
      if (this.workbook.formulas.size > 0)
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
    try {
      for (const p of patches) {
        const op = this.#patchOps.get(p.op);
        if (op === undefined) throw new Error(`No plugin registers the patch op '${p.op}'.`);
        this.#engine.willApply(p);
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
    this.#revision += 1;
    for (const l of [...this.#selectionListeners]) l(s);
  }

  #emit(tx: Transaction): void {
    if (tx.origin === 'load') this.#engine.reset();
    if (this.#edit !== null && !this.workbook.hasSheet(this.#edit.sheet)) this.#setEdit(null);
    this.#revision += 1;
    for (const l of [...this.#listeners]) l(tx);
  }
}

/** A model: from `data` (a `CellsWorkbook`), or one empty sheet. */
export function createCellsModel(options: CellsModelOptions = {}): CellsModel {
  return new CellsModel(options);
}
