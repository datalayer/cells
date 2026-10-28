/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The formula engine. A formula cell is parsed once, its shape compiled once,
 * and its precedents registered in the dependency graph: single cells (and
 * ranges of at most 8 cells) in a hash map from a cell to the formulas reading
 * it, larger ranges as rectangles in an R-tree (`rbush`), whole columns and
 * rows as one rectangle each, never expanded. What the engine keeps of a cell
 * lives on its formula entry in the store: its shape and constants, and its
 * computed value (`cached`), so a formula costs no map entry of its own.
 *
 * Values are computed on read and kept. A change of cells drops the values
 * depending on it, breadth first through the map and the R-tree; only computed
 * values are dropped (a formula never read has nothing to drop, and its
 * dependents cannot have been read without it). The dropped cells are then
 * evaluated in the background, in slices of at most 8 ms, in the order the
 * change reached them; a read meanwhile evaluates what it reads first, so reads
 * are never stale and the cells on screen come first. A chain deeper than the
 * stack is evaluated from its far end; cycles are `#CYCLE!`.
 *
 * @module formula/engine
 */

import RBush from 'rbush';
import type { FormulaEntry } from '../core/cells.js';
import type { CellValue } from '../core/values.js';
import type { Patch } from '../core/patches.js';
import type { Workbook } from '../core/workbook.js';
import type { Zone } from '../core/zone.js';
import type { FormulaFunction, FunctionContext } from '../points/index.js';
import type { Ast } from './ast.js';
import { type Compiled, compile, type Evaluation, scalar } from './compile.js';
import { shapeOf } from './normal.js';
import { FormulaSyntaxError, parseFormula } from './parser.js';
import {
  err,
  ErrorValue,
  isMatrix,
  isReference,
  isUnion,
  type Reference,
  type Value,
} from './values.js';

/** What an asynchronous function resolved to, as a cell holds it. */
function toCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : err('#NUM!', 'Not a finite number.');
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'object' && 'error' in v) return v as CellValue;
  return err('#VALUE!', 'An asynchronous function resolved to something a cell cannot hold.');
}

/** How deep evaluation recurses before it restarts from the deeper cell. */
const MAX_DEPTH = 200;
/** The longest a background slice runs. */
const SLICE_MS = 8;
/** Ranges this small are registered cell by cell, in the map, not in the R-tree. */
const SMALL_RANGE = 8;
/** A cell read by this many formulas keeps them in a `Set`; fewer, in an array. */
const MANY_READERS = 8;

// A cell's key: its sheet's number, row and column in one exact integer.
const COLS = 2 ** 14;
const SHEET = 2 ** 35;
const keyOf = (sheet: number, row: number, col: number) => sheet * SHEET + row * COLS + col;
const sheetOfKey = (k: number) => Math.floor(k / SHEET);
const rowOfKey = (k: number) => Math.floor((k % SHEET) / COLS);
const colOfKey = (k: number) => k % COLS;

/** Patch ops that change no value a formula can read. */
const VALUE_NEUTRAL = new Set(['axis-sizes', 'merges', 'frozen', 'sheet-move', 'chart']);

/** Charts whose ranges are checked against the waiting cells at the end of a slice; past this many waiting, they wait for the pass to end. */
const CHART_PENDING_SCAN = 20_000;

class TooDeep {
  constructor(readonly key: number) {}
}

/** A range precedent in the R-tree: its rectangle (x columns, y rows) and the formula cell reading it. */
interface RangeItem {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly dependent: number;
}

const sameItem = (a: RangeItem, b: RangeItem) =>
  a.dependent === b.dependent &&
  a.minX === b.minX &&
  a.minY === b.minY &&
  a.maxX === b.maxX &&
  a.maxY === b.maxY;

/**
 * A chart's range in the R-tree (§3.12): a node that is not a cell. The same
 * search that finds a formula's dependents finds the charts reading a zone.
 */
interface ChartItem {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly chart: string;
}

const sameChartItem = (a: ChartItem, b: ChartItem) =>
  a.chart === b.chart &&
  a.minX === b.minX &&
  a.minY === b.minY &&
  a.maxX === b.maxX &&
  a.maxY === b.maxY;

/** A chart's key in the engine: its sheet and its id. */
export const chartKey = (sheet: string, id: string) => `${sheet}\u0000${id}`;
const chartOfKey = (key: string): { sheet: string; id: string } => {
  const i = key.indexOf('\u0000');
  return { sheet: key.slice(0, i), id: key.slice(i + 1) };
};

/** A range a chart reads: a sheet and a zone. */
export interface ChartRange {
  readonly sheet: string;
  readonly zone: Zone;
}

/** A compiled shape, shared by every cell holding it. */
interface Shape {
  readonly compiled: Compiled;
  readonly volatile: boolean;
}

/** What a formula entry keeps once parsed: its shape, or its shape followed by its constants. */
type Parsed = Shape | readonly unknown[];

const NO_CONSTANTS: readonly unknown[] = [];

/** The functions the engine compiles against, and a revision that changes when they do. */
export interface FunctionSource {
  readonly revision: number;
  get(name: string): FormulaFunction | undefined;
}

/** Runs a task soon, after the current one: the background slices. */
export type Scheduler = (task: () => void) => void;

/**
 * `scheduler.postTask` at background priority where there is one; else
 * `setImmediate` (Node: timers and I/O run between slices); else a
 * `MessageChannel` message (no 4-ms clamp, unlike `setTimeout`).
 */
export function defaultScheduler(): Scheduler {
  const g = globalThis as {
    scheduler?: { postTask?: (t: () => void, o: { priority: string }) => Promise<void> };
    setImmediate?: (t: () => void) => { unref?: () => void };
  };
  if (typeof g.scheduler?.postTask === 'function') {
    const post = g.scheduler.postTask.bind(g.scheduler);
    return (task) => void post(task, { priority: 'background' });
  }
  if (typeof g.setImmediate === 'function') {
    const immediate = g.setImmediate;
    return (task) => void immediate(task).unref?.();
  }
  const channel = new MessageChannel();
  const tasks: (() => void)[] = [];
  channel.port1.onmessage = () => tasks.shift()?.();
  return (task) => {
    tasks.push(task);
    channel.port2.postMessage(null);
  };
}

/** Evaluation at one cell: what compiled formulas and functions read. */
class At implements Evaluation, FunctionContext {
  constructor(
    readonly engine: FormulaEngine,
    readonly sheet: string,
    readonly row: number,
    readonly col: number,
    readonly constants: readonly unknown[],
  ) {}
  get context(): FunctionContext {
    return this;
  }
  read(ref: Reference): CellValue[][] {
    return this.engine.read(ref);
  }
  values(v: Value): Iterable<CellValue> {
    return this.engine.values(v);
  }
  cell(sheet: string, row: number, col: number): CellValue {
    return this.engine.value(sheet, row, col);
  }
  sheetByName(name: string): string | undefined {
    return this.engine.sheetByName(name);
  }
  extent(ref: Reference): Reference {
    return this.engine.extent(ref);
  }
  limits(sheet: string): { rows: number; cols: number } {
    return this.engine.limits(sheet);
  }
  awaited(name: string, args: readonly unknown[], run: () => unknown): CellValue {
    return this.engine.awaited(this.sheet, this.row, this.col, name, args, run);
  }
}

/** A call of an asynchronous function: running, or settled with its value. */
interface Awaited {
  value: CellValue | undefined;
}

/** Arguments as a key: scalars as they are, references by their cells, lazy arguments refused. */
function argumentsKey(args: readonly unknown[]): string {
  return JSON.stringify(args, (_, v: unknown) => {
    if (typeof v === 'function')
      throw new Error('An asynchronous function cannot take lazy arguments.');
    return v;
  });
}

export class FormulaEngine {
  readonly #workbook: Workbook;
  readonly #functions: FunctionSource;
  readonly #schedule: Scheduler;
  #functionsRevision: number;
  readonly #shapes = new Map<string, Shape>();
  readonly #sheetNumbers = new Map<string, number>();
  readonly #sheetIds: string[] = [];
  /** Single-cell precedents: the formula cells reading each cell. */
  readonly #readers = new Map<number, number | number[] | Set<number>>();
  /** Range precedents, per sheet number. */
  readonly #trees = new Map<number, RBush<RangeItem>>();
  readonly #volatile = new Set<number>();
  readonly #evaluating = new Set<number>();
  /** Zones written by the patches being applied, waiting for `flush`. */
  #written: [number, Zone][] = [];
  #mustReset = false;
  /** Dropped cells waiting for the background, in the order the change reached them. */
  #pending: number[] = [];
  #next = 0;
  #scheduled = false;
  #depth = 0;
  #compiles = 0;
  #parsed = 0;
  #sliceMs = 0;
  /** Asynchronous calls, by cell key, function and arguments. */
  #awaited = new Map<string, Awaited>();
  #busy = 0;
  readonly #onSettled: () => void;
  /** Charts' ranges, per sheet number (§3.12). */
  readonly #chartTrees = new Map<number, RBush<ChartItem>>();
  /** What each chart registered, so it leaves the trees as it came. */
  readonly #chartItems = new Map<string, [number, ChartItem][]>();
  /** Charts whose ranges a pass dirtied, waiting for their cells to settle. */
  readonly #markedCharts = new Set<string>();
  /** How many times each chart's data settled: what a drawing memoises on. */
  readonly #chartRevisions = new Map<string, number>();
  readonly #chartRanges: (sheet: string, spec: unknown) => readonly ChartRange[];
  readonly #onCharts: (charts: readonly { sheet: string; id: string }[]) => void;

  constructor(
    workbook: Workbook,
    functions: FunctionSource,
    options: {
      schedule?: Scheduler;
      onSettled?: () => void;
      /** The ranges a chart reads (the model resolves its references). */
      chartRanges?: (sheet: string, spec: unknown) => readonly ChartRange[];
      /** Charts whose data settled: rebuilt once, after the slice their cells settled in. */
      onCharts?: (charts: readonly { sheet: string; id: string }[]) => void;
    } = {},
  ) {
    this.#workbook = workbook;
    this.#functions = functions;
    this.#functionsRevision = functions.revision;
    this.#schedule = options.schedule ?? defaultScheduler();
    this.#onSettled = options.onSettled ?? (() => undefined);
    this.#chartRanges = options.chartRanges ?? (() => []);
    this.#onCharts = options.onCharts ?? (() => undefined);
  }

  // ------------------------------------------------------------ charts

  /** How many times a chart's data settled since it was registered; 0 for a chart the engine never saw. */
  chartRevision(sheet: string, id: string): number {
    return this.#chartRevisions.get(chartKey(sheet, id)) ?? 0;
  }

  /** The charts waiting for their cells to settle. */
  markedCharts(): { sheet: string; id: string }[] {
    return [...this.#markedCharts].map(chartOfKey);
  }

  #registerChart(sheet: string, id: string, spec: unknown): void {
    const key = chartKey(sheet, id);
    this.#unregisterChart(key);
    const items: [number, ChartItem][] = [];
    for (const r of this.#chartRanges(sheet, spec)) {
      const n = this.#sheetNumber(r.sheet);
      const item: ChartItem = {
        minX: r.zone.left,
        maxX: r.zone.right,
        minY: r.zone.top,
        maxY: r.zone.bottom,
        chart: key,
      };
      let tree = this.#chartTrees.get(n);
      if (tree === undefined) {
        tree = new RBush<ChartItem>();
        this.#chartTrees.set(n, tree);
      }
      tree.insert(item);
      items.push([n, item]);
    }
    this.#chartItems.set(key, items);
  }

  #unregisterChart(key: string): void {
    const items = this.#chartItems.get(key);
    if (items === undefined) return;
    for (const [n, item] of items) this.#chartTrees.get(n)?.remove(item, sameChartItem);
    this.#chartItems.delete(key);
  }

  #markChartsAt(sheet: number, box: { minX: number; minY: number; maxX: number; maxY: number }) {
    const tree = this.#chartTrees.get(sheet);
    if (tree === undefined) return;
    for (const item of tree.search(box)) this.#markedCharts.add(item.chart);
  }

  /**
   * The marked charts whose cells settled: their revision moves and the model
   * hears of them, once. Mid-pass (`final` false), a chart with a cell still
   * waiting inside one of its ranges keeps waiting; the check scans the
   * waiting cells, so past `CHART_PENDING_SCAN` of them every chart waits for
   * the pass to end.
   */
  #settleCharts(final: boolean): void {
    if (this.#markedCharts.size === 0) return;
    const remaining = this.#pending.length - this.#next;
    const settled: { sheet: string; id: string }[] = [];
    for (const key of this.#markedCharts) {
      if (!final && remaining > 0) {
        if (remaining > CHART_PENDING_SCAN || this.#chartHasPending(key)) continue;
      }
      this.#markedCharts.delete(key);
      if (!this.#chartItems.has(key)) continue; // deleted while marked
      this.#chartRevisions.set(key, (this.#chartRevisions.get(key) ?? 0) + 1);
      settled.push(chartOfKey(key));
    }
    if (settled.length > 0) this.#onCharts(settled);
  }

  #chartHasPending(key: string): boolean {
    const items = this.#chartItems.get(key);
    if (items === undefined) return false;
    for (let i = this.#next; i < this.#pending.length; i += 1) {
      const k = this.#pending[i];
      const sheet = sheetOfKey(k);
      const r = rowOfKey(k);
      const c = colOfKey(k);
      for (const [n, item] of items)
        if (n === sheet && r >= item.minY && r <= item.maxY && c >= item.minX && c <= item.maxX)
          return true;
    }
    return false;
  }

  /**
   * An asynchronous call's value for a cell: started once per arguments,
   * `#BUSY!` until it settles; then the cell and its dependents recalculate
   * and `onSettled` tells the model.
   */
  awaited(
    sheet: string,
    row: number,
    col: number,
    name: string,
    args: readonly unknown[],
    run: () => unknown,
  ): CellValue {
    const cell = keyOf(this.#sheetNumber(sheet), row, col);
    const key = `${cell}|${name}|${argumentsKey(args)}`;
    const known = this.#awaited.get(key);
    if (known !== undefined) return known.value ?? err('#BUSY!', `${name} is running.`);
    const call: Awaited = { value: undefined };
    this.#awaited.set(key, call);
    this.#busy += 1;
    const settle = (value: CellValue) => {
      if (this.#awaited.get(key) !== call) return; // forgotten: the cell changed meanwhile
      call.value = value;
      this.#busy -= 1;
      const dirty: number[] = [];
      this.#drop(cell, dirty);
      this.#propagate(dirty);
      this.#onSettled();
    };
    Promise.resolve()
      .then(run)
      .then(
        (v) => settle(toCellValue(v)),
        (error: unknown) =>
          settle(error instanceof ErrorValue ? error.value : err('#VALUE!', String(error))),
      );
    return err('#BUSY!', `${name} is running.`);
  }

  /** Forget the asynchronous calls of a cell (its formula changed). */
  #forgetAwaited(cell: number): void {
    const prefix = `${cell}|`;
    for (const [k, call] of this.#awaited) {
      if (!k.startsWith(prefix)) continue;
      if (call.value === undefined) this.#busy -= 1;
      this.#awaited.delete(k);
    }
  }

  /** Counters: shapes compiled (and compilations run), formula cells parsed, cells waiting, the last slice. */
  stats(): {
    shapes: number;
    compiles: number;
    parsed: number;
    pending: number;
    calculating: boolean;
    /** Asynchronous calls still running. */
    busy: number;
    lastSliceMs: number;
  } {
    const pending = this.#pending.length - this.#next;
    return {
      shapes: this.#shapes.size,
      compiles: this.#compiles,
      parsed: this.#parsed,
      pending,
      calculating: pending > 0,
      busy: this.#busy,
      lastSliceMs: this.#sliceMs,
    };
  }

  // ------------------------------------------------------------ changes

  /** Forget every parse and value: the workbook was replaced or its structure changed. */
  reset(): void {
    this.#workbook.formulas.forEach((f) => {
      f.cached = null;
      f.parsed = undefined;
    });
    this.#readers.clear();
    this.#trees.clear();
    this.#volatile.clear();
    this.#pending = [];
    this.#next = 0;
    this.#parsed = 0;
    this.#written = [];
    this.#mustReset = false;
    this.#awaited = new Map();
    this.#busy = 0;
    // Charts are registered again from the workbook (their ranges were
    // rewritten with the structure), and every one of them changed: the
    // revisions move at once, silently, since what follows a reset is a
    // change the model announces anyway.
    this.#chartTrees.clear();
    this.#chartItems.clear();
    this.#markedCharts.clear();
    for (const sheet of this.#workbook.sheets)
      for (const [id, spec] of sheet.charts) {
        this.#registerChart(sheet.id, id, spec);
        const key = chartKey(sheet.id, id);
        this.#chartRevisions.set(key, (this.#chartRevisions.get(key) ?? 0) + 1);
      }
  }

  /** A patch is about to be applied: formulas it overwrites leave the graph. */
  willApply(p: Patch): void {
    if (this.#mustReset) return;
    if (p.op !== 'cells') {
      if (!VALUE_NEUTRAL.has(p.op)) this.#mustReset = true;
      return;
    }
    const { sheet, zone } = p as Patch & { sheet: string; zone: Zone };
    const cells = this.#workbook.sheet(sheet).cells;
    const n = this.#sheetNumber(sheet);
    for (const [row, col, content] of cells.entries(zone)) {
      if (content.formula === undefined) continue;
      const f = cells.formulaAt(row, col)!;
      if (f.parsed !== undefined) this.#unregister(f, sheet, n, row, col);
    }
  }

  /** A patch was applied. */
  applied(p: Patch): void {
    if (this.#mustReset) return;
    if (p.op === 'chart') {
      const { sheet, id, after } = p as Patch & { sheet: string; id: string; after: unknown };
      const key = chartKey(sheet, id);
      if (after === null) {
        this.#unregisterChart(key);
        this.#markedCharts.delete(key);
        this.#chartRevisions.delete(key);
      } else {
        this.#registerChart(sheet, id, after);
        this.#markedCharts.add(key); // its ranges may have changed: it reads again
      }
      return;
    }
    if (p.op !== 'cells') return;
    const { sheet, zone } = p as Patch & { sheet: string; zone: Zone };
    this.#written.push([this.#sheetNumber(sheet), zone]);
  }

  /** Every patch of a step was applied: drop what depends on them, then recalculate in the background. */
  flush(): void {
    if (this.#mustReset) {
      // Rows, columns or sheets moved: positions and names no longer mean what they did.
      this.reset();
      return;
    }
    const dirty: number[] = [];
    for (const [sheet, zone] of this.#written) this.#zoneWritten(sheet, zone, dirty);
    this.#written = [];
    for (const k of this.#volatile) this.#drop(k, dirty);
    this.#propagate(dirty);
    // Nothing left to compute: the charts the step marked settle with it.
    if (this.#next >= this.#pending.length) this.#settleCharts(true);
  }

  #zoneWritten(sheet: number, zone: Zone, dirty: number[]): void {
    const cells = this.#workbook.sheet(this.#sheetIds[sheet]).cells;
    // Formulas written here are new: values they carry (an undo's) are not trusted.
    for (const [row, col, content] of cells.entries(zone)) {
      if (content.formula === undefined) continue;
      cells.formulaAt(row, col)!.cached = null;
      dirty.push(keyOf(sheet, row, col));
    }
    const area = (zone.bottom - zone.top + 1) * (zone.right - zone.left + 1);
    if (area <= this.#readers.size) {
      for (let r = zone.top; r <= zone.bottom; r += 1)
        for (let c = zone.left; c <= zone.right; c += 1) this.#readersOf(keyOf(sheet, r, c), dirty);
    } else {
      for (const k of [...this.#readers.keys()]) {
        if (sheetOfKey(k) !== sheet) continue;
        const r = rowOfKey(k);
        const c = colOfKey(k);
        if (r >= zone.top && r <= zone.bottom && c >= zone.left && c <= zone.right)
          this.#readersOf(k, dirty);
      }
    }
    const box = { minX: zone.left, minY: zone.top, maxX: zone.right, maxY: zone.bottom };
    const tree = this.#trees.get(sheet);
    if (tree !== undefined) for (const item of tree.search(box)) this.#drop(item.dependent, dirty);
    this.#markChartsAt(sheet, box);
  }

  #readersOf(k: number, dirty: number[]): void {
    const readers = this.#readers.get(k);
    if (readers === undefined) return;
    if (typeof readers === 'number') this.#drop(readers, dirty);
    else for (const r of readers) this.#drop(r, dirty);
  }

  /** Drop a computed value; a value never computed has no dependents computed either. */
  #drop(k: number, dirty: number[]): void {
    const f = this.#formulaOf(k);
    if (f === undefined || f.cached === null) return;
    f.cached = null;
    dirty.push(k);
  }

  #formulaOf(k: number): FormulaEntry | undefined {
    const sheet = this.#sheetIds[sheetOfKey(k)];
    if (!this.#workbook.hasSheet(sheet)) return undefined;
    return this.#workbook.sheet(sheet).cells.formulaAt(rowOfKey(k), colOfKey(k));
  }

  /** Breadth first from the dropped cells, through readers and the R-tree, then queue them all. */
  #propagate(dirty: number[]): void {
    for (let i = 0; i < dirty.length; i += 1) {
      const k = dirty[i];
      this.#readersOf(k, dirty);
      const sheet = sheetOfKey(k);
      const r = rowOfKey(k);
      const c = colOfKey(k);
      const point = { minX: c, minY: r, maxX: c, maxY: r };
      const tree = this.#trees.get(sheet);
      if (tree !== undefined)
        for (const item of tree.search(point)) this.#drop(item.dependent, dirty);
      this.#markChartsAt(sheet, point);
    }
    if (dirty.length === 0) return;
    if (this.#next >= this.#pending.length) {
      this.#pending = dirty;
      this.#next = 0;
    } else {
      for (const k of dirty) this.#pending.push(k);
    }
    if (!this.#scheduled) {
      this.#scheduled = true;
      this.#schedule(() => this.#slice());
    }
  }

  /** One background slice: evaluate waiting cells for at most 8 ms, then yield. */
  #slice(): void {
    this.#scheduled = false;
    const start = performance.now();
    const deadline = start + SLICE_MS;
    while (this.#next < this.#pending.length) {
      this.#evaluatePending();
      if ((this.#next & 63) === 0 && performance.now() > deadline) break;
    }
    this.#sliceMs = performance.now() - start;
    if (this.#next < this.#pending.length) {
      this.#scheduled = true;
      this.#schedule(() => this.#slice());
      this.#settleCharts(false);
    } else {
      this.#pending = [];
      this.#next = 0;
      this.#settleCharts(true);
    }
  }

  #evaluatePending(): void {
    const k = this.#pending[this.#next];
    this.#next += 1;
    const sheet = this.#sheetIds[sheetOfKey(k)];
    // A sheet deleted meanwhile has nothing left to compute.
    if (this.#workbook.hasSheet(sheet)) this.value(sheet, rowOfKey(k), colOfKey(k));
  }

  /** Evaluate every waiting cell now (benches, and hosts that export right after a change). */
  settle(): void {
    while (this.#next < this.#pending.length) this.#evaluatePending();
    this.#pending = [];
    this.#next = 0;
    this.#settleCharts(true);
  }

  // ------------------------------------------------------------ reading

  /** What a cell shows: its literal value, or its formula evaluated. */
  value(sheet: string, row: number, col: number): CellValue {
    if (this.#functions.revision !== this.#functionsRevision) this.#functionsChanged();
    const cells = this.#workbook.sheet(sheet).cells;
    const f = cells.formulaAt(row, col);
    if (f === undefined) {
      const n = cells.numberAt(row, col);
      if (n !== undefined) return n;
      return cells.get(row, col)?.value ?? null;
    }
    if (f.cached !== null) return f.cached;
    const key = keyOf(this.#sheetNumber(sheet), row, col);
    if (this.#depth === 0) return this.#settleFrom(key);
    if (this.#depth >= MAX_DEPTH) throw new TooDeep(key);
    return this.#evaluate(key, sheet, row, col, f);
  }

  /** Every value of a reference, array, union or scalar that holds something. */
  values(v: Value): CellValue[] {
    if (isReference(v)) return this.#referenceValues(v);
    if (isUnion(v)) return v.refs.flatMap((r) => this.#referenceValues(r));
    if (isMatrix(v)) return v.rows.flat().filter((x) => x !== null);
    return v === null ? [] : [v];
  }

  /** A reference's values as rows, bounded by the last row holding something in its columns. */
  read(ref: Reference): CellValue[][] {
    const cells = this.#workbook.sheet(ref.sheet).cells;
    let last = -1;
    for (let c = ref.zone.left; c <= ref.zone.right; c += 1)
      last = Math.max(last, cells.lastRowIn(c));
    const bottom = Math.min(ref.zone.bottom, Math.max(last, ref.zone.top));
    const rows: CellValue[][] = [];
    for (let r = ref.zone.top; r <= bottom; r += 1) {
      const row: CellValue[] = [];
      for (let c = ref.zone.left; c <= ref.zone.right; c += 1)
        row.push(this.value(ref.sheet, r, c));
      rows.push(row);
    }
    return rows;
  }

  sheetByName(name: string): string | undefined {
    return this.#workbook.sheetByName(name)?.id;
  }

  /** A reference clipped to the rows and columns holding something (at least its first cell). */
  extent(ref: Reference): Reference {
    const cells = this.#workbook.sheet(ref.sheet).cells;
    const z = ref.zone;
    let lastCol = z.left;
    for (const c of cells.columnIndexes()) if (c <= z.right && c > lastCol) lastCol = c;
    let lastRow = z.top;
    for (let c = z.left; c <= lastCol; c += 1) lastRow = Math.max(lastRow, cells.lastRowIn(c));
    const bottom = Math.min(z.bottom, lastRow);
    const right = Math.min(z.right, lastCol);
    if (bottom === z.bottom && right === z.right) return ref;
    return { kind: 'ref', sheet: ref.sheet, zone: { ...z, bottom, right } };
  }

  limits(sheet: string): { rows: number; cols: number } {
    const s = this.#workbook.sheet(sheet);
    return { rows: s.rows.count, cols: s.cols.count };
  }

  #referenceValues(ref: Reference): CellValue[] {
    const out: CellValue[] = [];
    this.#workbook.sheet(ref.sheet).cells.scan(ref.zone, (row, col, value, formula) => {
      const v = formula ? this.value(ref.sheet, row, col) : value;
      if (v !== null) out.push(v);
    });
    return out;
  }

  /** Functions switched on or off: every shape and value may differ. */
  #functionsChanged(): void {
    this.#functionsRevision = this.#functions.revision;
    this.#shapes.clear();
    this.reset();
  }

  #sheetNumber(sheet: string): number {
    let n = this.#sheetNumbers.get(sheet);
    if (n === undefined) {
      n = this.#sheetIds.length;
      this.#sheetIds.push(sheet);
      this.#sheetNumbers.set(sheet, n);
    }
    return n;
  }

  /** Evaluate a cell from the top: chains too deep restart from their deeper end. */
  #settleFrom(key: number): CellValue {
    const pending: number[] = [key];
    const restarted = new Set<number>();
    while (pending.length > 0) {
      const k = pending[pending.length - 1];
      const f = this.#formulaOf(k);
      if (f === undefined || f.cached !== null) {
        pending.pop();
        continue;
      }
      try {
        this.#evaluate(k, this.#sheetIds[sheetOfKey(k)], rowOfKey(k), colOfKey(k), f);
        pending.pop();
      } catch (error) {
        if (!(error instanceof TooDeep)) throw error;
        if (restarted.has(error.key)) {
          // Reached again from its own restart: a cycle longer than the stack.
          this.#formulaOf(error.key)!.cached = err('#CYCLE!', 'The formula refers to itself.');
        } else {
          restarted.add(error.key);
          pending.push(error.key);
        }
      }
    }
    return this.#formulaOf(key)!.cached;
  }

  #evaluate(key: number, sheet: string, row: number, col: number, f: FormulaEntry): CellValue {
    if (this.#evaluating.has(key)) return err('#CYCLE!', 'The formula refers to itself.');
    const parsed = (f.parsed as Parsed | undefined) ?? this.#parse(f, sheet, row, col, key);
    const many = Array.isArray(parsed);
    const shape = (many ? parsed[0] : parsed) as Shape;
    let result: CellValue;
    this.#depth += 1;
    this.#evaluating.add(key);
    try {
      const at = new At(this, sheet, row, col, many ? parsed : NO_CONSTANTS);
      const v = scalar(shape.compiled(at), at);
      // A formula pointing at an empty cell shows 0, as in Excel.
      result = v === null ? 0 : v;
    } finally {
      this.#depth -= 1;
      this.#evaluating.delete(key);
    }
    f.cached = result;
    return result;
  }

  // ------------------------------------------------------------ parsing and the graph

  #parse(f: FormulaEntry, sheet: string, row: number, col: number, key: number): Parsed {
    let ast: Ast;
    try {
      ast = parseFormula(f.source).ast;
    } catch (error) {
      if (!(error instanceof FormulaSyntaxError)) throw error;
      const value = err('#NAME?', error.message);
      const shape: Shape = { compiled: () => value, volatile: false };
      f.parsed = shape;
      this.#parsed += 1;
      return shape;
    }
    const { key: shapeKey, constants } = shapeOf(ast, { row, col });
    let shape = this.#shapes.get(shapeKey);
    if (shape === undefined) {
      const flags = { volatile: false };
      const compiled = compile(ast, { row, col }, (name) => this.#functions.get(name), flags);
      this.#compiles += 1;
      shape = { compiled, volatile: flags.volatile };
      this.#shapes.set(shapeKey, shape);
    }
    const parsed: Parsed = constants.length === 0 ? shape : [shape, ...constants];
    f.parsed = parsed;
    this.#parsed += 1;
    this.#precedents(
      ast,
      sheet,
      key,
      (cell) => this.#addReader(cell, key),
      (n, item) => {
        let tree = this.#trees.get(n);
        if (tree === undefined) {
          tree = new RBush<RangeItem>();
          this.#trees.set(n, tree);
        }
        tree.insert(item);
      },
    );
    if (shape.volatile) this.#volatile.add(key);
    return parsed;
  }

  #addReader(cell: number, reader: number): void {
    const readers = this.#readers.get(cell);
    if (readers === undefined) {
      this.#readers.set(cell, reader);
    } else if (typeof readers === 'number') {
      if (readers !== reader) this.#readers.set(cell, [readers, reader]);
    } else if (Array.isArray(readers)) {
      if (readers.includes(reader)) return;
      if (readers.length < MANY_READERS) readers.push(reader);
      else this.#readers.set(cell, new Set([...readers, reader]));
    } else {
      readers.add(reader);
    }
  }

  #removeReader(cell: number, reader: number): void {
    const readers = this.#readers.get(cell);
    if (readers === undefined) return;
    if (typeof readers === 'number') {
      if (readers === reader) this.#readers.delete(cell);
    } else if (Array.isArray(readers)) {
      const i = readers.indexOf(reader);
      if (i >= 0) readers.splice(i, 1);
      if (readers.length === 1) this.#readers.set(cell, readers[0]);
    } else {
      readers.delete(reader);
      if (readers.size === 0) this.#readers.delete(cell);
    }
  }

  /** A formula leaves the graph: its precedents, found again from its source. */
  #unregister(f: FormulaEntry, sheet: string, sheetNo: number, row: number, col: number): void {
    const key = keyOf(sheetNo, row, col);
    f.parsed = undefined;
    this.#parsed -= 1;
    this.#volatile.delete(key);
    this.#forgetAwaited(key);
    let ast: Ast;
    try {
      ast = parseFormula(f.source).ast;
    } catch {
      return; // It never parsed, so it read nothing.
    }
    this.#precedents(
      ast,
      sheet,
      key,
      (cell) => this.#removeReader(cell, key),
      (n, item) => this.#trees.get(n)?.remove(item, sameItem),
    );
  }

  /** The cells and ranges a formula reads, at its position; unknown sheets read nothing (yet). */
  #precedents(
    ast: Ast,
    sheet: string,
    dependent: number,
    onCell: (key: number) => void,
    onRange: (sheet: number, item: RangeItem) => void,
  ): void {
    const sheetOf = (name: string | undefined) =>
      name === undefined ? sheet : this.#workbook.sheetByName(name)?.id;
    const walk = (a: Ast): void => {
      switch (a.type) {
        case 'cell': {
          const s = sheetOf(a.sheet);
          if (s === undefined || a.ref.row === undefined || a.ref.col === undefined) return;
          onCell(keyOf(this.#sheetNumber(s), a.ref.row, a.ref.col));
          return;
        }
        case 'range': {
          const s = sheetOf(a.sheet);
          if (s === undefined) return;
          const limits = this.limits(s);
          const r0 = a.from.row ?? 0;
          const r1 = a.to.row ?? limits.rows - 1;
          const c0 = a.from.col ?? 0;
          const c1 = a.to.col ?? limits.cols - 1;
          const top = Math.min(r0, r1);
          const bottom = Math.max(r0, r1);
          const left = Math.min(c0, c1);
          const right = Math.max(c0, c1);
          const n = this.#sheetNumber(s);
          if ((bottom - top + 1) * (right - left + 1) <= SMALL_RANGE) {
            for (let r = top; r <= bottom; r += 1)
              for (let c = left; c <= right; c += 1) onCell(keyOf(n, r, c));
          } else {
            onRange(n, { minX: left, maxX: right, minY: top, maxY: bottom, dependent });
          }
          return;
        }
        case 'call':
          a.args.forEach(walk);
          return;
        case 'unary':
        case 'percent':
          walk(a.arg);
          return;
        case 'binary':
          walk(a.left);
          walk(a.right);
          return;
        case 'union':
          a.items.forEach(walk);
          return;
        case 'array':
          a.rows.forEach((r) => r.forEach(walk));
          return;
        default:
          return;
      }
    };
    walk(ast);
  }
}
