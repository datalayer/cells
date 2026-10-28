/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The binding of a model to a Loro document (§3.9): positions in memory,
 * ids on the wire.
 *
 * - **Local to Loro.** Each committed change of the model is translated, patch
 *   by patch, into Loro operations on ids, in one Loro commit: cell writes
 *   into the sheet's cell map keyed `<rowId>.<colId>`, insertions, deletions
 *   and moves of rows and columns into the axis maps (`axis.ts`), merges,
 *   sizes, frozen panes and sheets into theirs. Formulas go in id form: each
 *   reference names the ids of its row and column, so a row inserted above by
 *   another peer moves it, and a row deleted turns it into `#REF!`.
 * - **Loro to local.** Any other change of the document (an update imported
 *   from a peer, an undo) is projected into the model whole, as a
 *   `CellsWorkbook` (`model.replaceData(…, 'remote')`).
 * - **History.** Undo and redo are Loro's `UndoManager`: each peer undoes its
 *   own changes only, whatever arrived from the others meanwhile.
 *
 * @module collab/binding
 */

import { LoroDoc, LoroMap, LoroMovableList, UndoManager } from 'loro-crdt';
import type { CellsSheet, CellsWorkbook, JsonValue } from '../core/format.js';
import type { CellsModel, Transaction } from '../core/model.js';
import type { SelectionState } from '../core/selection.js';

/** A selection in id form, as the awareness carries it. */
export interface PresenceIds {
  readonly sheet: string;
  /** Each zone's corners: [rowId, colId, rowId, colId]. */
  readonly zones: readonly (readonly [string, string, string, string])[];
  readonly active: readonly [string, string];
}
import type { CellsPatch, Patch } from '../core/patches.js';
import { snapshotEntries } from '../core/patches.js';
import type { Style } from '../core/styles.js';
import type { DataSourceBinding, DataSourcePatch } from '../core/dataSources.js';
import { isCellError } from '../core/values.js';
import type { Zone } from '../core/zone.js';
import { tokenize } from '../formula/tokens.js';
import { AxisOrder, implicitId, insert, move, remove } from './axis.js';
import {
  type ChartAnchor,
  type ChartPatch,
  type ChartSeries,
  type ChartSpec,
  refAst,
} from '../core/charts.js';
import { type CodeCell, type CodePatch, codePosition, codeRef } from '../core/code.js';

/** The id of the sheet shown when the document has none left. */
const EMPTY_SHEET = 'empty';

/** The origin of the binding's own commits: what it does not project back. */
const LOCAL = 'cells-local';

interface StoredCell {
  v?: JsonValue;
  f?: string;
  s?: Style;
}

type AxisName = 'rows' | 'cols';

/** Column letters to an index: `A` is 0. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function columnLetters(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const REFERENCE = /^(\$?)([A-Za-z]{1,3})?(\$?)([0-9]{1,7})?$/;
/** A reference in id form: `⟦$col|$row⟧`, either part empty for whole rows or columns. */
const ID_FORM = /⟦(\$?)([^|⟧]*)\|(\$?)([^⟧]*)⟧/g;

/** How a `LoroBinding` is set up: the peer's id in the room. */
export interface BindingOptions {
  /** This peer's name in the ids it makes (`p<peer>-<n>`): unique among the peers of a document. */
  readonly peer: string;
}

/** A model bound to a Loro document (§3.9): local patches written on ids, remote changes projected into the model, undo per peer. */
export class LoroBinding {
  readonly model: CellsModel;
  readonly doc: LoroDoc;
  readonly #peer: string;
  readonly #counter = { next: 0 };
  readonly #undo: UndoManager;
  readonly #unsubscribe: (() => void)[] = [];
  #projecting = false;

  constructor(model: CellsModel, doc: LoroDoc, options: BindingOptions) {
    this.model = model;
    this.doc = doc;
    this.#peer = options.peer;
    // Sheets this peer adds get ids no other peer makes.
    model.workbook.sheetIdPrefix = `p${options.peer}-s`;
    if (this.#sheetsList().length === 0) this.#seed();
    else this.#project();
    this.#undo = new UndoManager(doc, { mergeInterval: 0 });
    this.#unsubscribe.push(model.subscribe((tx) => this.#local(tx)));
    this.#unsubscribe.push(
      doc.subscribe((event) => {
        if (event.origin !== LOCAL) this.#project();
      }),
    );
  }

  /** Undo this peer's last change (and only its own). */
  undo(): boolean {
    const done = this.#undo.undo();
    this.doc.commit();
    return done;
  }

  redo(): boolean {
    const done = this.#undo.redo();
    this.doc.commit();
    return done;
  }

  dispose(): void {
    for (const u of this.#unsubscribe) u();
  }

  // ------------------------------------------------------------ presence (§3.9)

  /** A selection in id form, for the awareness: the sheet's id, zones and cells by row and column ids. */
  selectionToIds(selection: SelectionState): PresenceIds {
    const rows = this.#order(selection.sheet, 'rows');
    const cols = this.#order(selection.sheet, 'cols');
    const cell = (p: { row: number; col: number }) =>
      [rows.idAt(p.row)!, cols.idAt(p.col)!] as [string, string];
    return {
      sheet: selection.sheet,
      zones: selection.zones.map((z) => [
        ...cell({ row: z.top, col: z.left }),
        ...cell({ row: z.bottom, col: z.right }),
      ]),
      active: cell(selection.active),
    };
  }

  /** A selection from id form at this peer's current positions; `undefined` once its sheet or cells are gone. */
  selectionFromIds(ids: PresenceIds): SelectionState | undefined {
    if (!(this.#sheetsList().toJSON() as string[]).includes(ids.sheet)) return undefined;
    const rows = this.#order(ids.sheet, 'rows');
    const cols = this.#order(ids.sheet, 'cols');
    const at = (r: string, c: string) => {
      const row = rows.positionOf(r);
      const col = cols.positionOf(c);
      return row === undefined || col === undefined ? undefined : { row, col };
    };
    const zones: Zone[] = [];
    for (const [r0, c0, r1, c1] of ids.zones) {
      const a = at(r0, c0);
      const b = at(r1, c1);
      if (a === undefined || b === undefined) continue;
      zones.push({
        top: Math.min(a.row, b.row),
        left: Math.min(a.col, b.col),
        bottom: Math.max(a.row, b.row),
        right: Math.max(a.col, b.col),
      });
    }
    const active = at(ids.active[0], ids.active[1]);
    if (zones.length === 0 || active === undefined) return undefined;
    return { sheet: ids.sheet, zones, anchor: active, active };
  }

  // ------------------------------------------------------------ the document

  #sheetsList(): LoroMovableList {
    return this.doc.getMovableList('sheets');
  }

  #sheetMap(id: string): LoroMap {
    return this.doc.getMap(`sheet:${id}`);
  }

  #axisMap(sheet: string, axis: AxisName): LoroMap {
    return this.doc.getMap(`${axis}:${sheet}`);
  }

  #cells(sheet: string): LoroMap {
    return this.doc.getMap(`cells:${sheet}`);
  }

  // Root containers only: two peers creating one nested container at once would race, one losing.
  #sizes(sheet: string, axis: AxisName): LoroMap {
    return this.doc.getMap(`sizes-${axis}:${sheet}`);
  }

  #hidden(sheet: string, axis: AxisName): LoroMap {
    return this.doc.getMap(`hidden-${axis}:${sheet}`);
  }

  #merges(sheet: string): LoroMap {
    return this.doc.getMap(`merges:${sheet}`);
  }

  /** The charts of a sheet (§3.12): chart id → a map of the spec's fields, ranges in id form, anchors on ids. */
  #charts(sheet: string): LoroMap {
    return this.doc.getMap(`charts:${sheet}`);
  }

  /** The code cells of a sheet (§3.13): `rowId.colId` → the code cell, whole (a run replaces it). */
  #code(sheet: string): LoroMap {
    return this.doc.getMap(`code:${sheet}`);
  }

  #count(axis: AxisName): number {
    return this.model.workbook.limits[axis];
  }

  #order(sheet: string, axis: AxisName): AxisOrder {
    return AxisOrder.of(this.#axisMap(sheet, axis), this.#count(axis));
  }

  /** A sheet's id by its name in the document (names compare as Excel's do, in any case). */
  #sheetIdByName(name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const id of this.#sheetsList().toJSON() as string[])
      if (String(this.#sheetMap(id).get('name')).toLowerCase() === lower) return id;
    return undefined;
  }

  // ------------------------------------------------------------ formulas

  /** A formula as typed, its references in id form for the sheet it is on. */
  #toIdForm(formula: string, sheet: string): string {
    let out = '';
    let target = sheet;
    for (const t of tokenize(formula)) {
      if (t.kind === 'sheet') {
        const raw = t.text.slice(0, -1);
        const name = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
        target = this.#sheetIdByName(name) ?? sheet;
        out += t.text;
        continue;
      }
      if (t.kind === 'ref') {
        const m = REFERENCE.exec(t.text);
        if (m !== null) {
          const col = m[2] === undefined ? '' : this.#order(target, 'cols').idAt(columnIndex(m[2]));
          const row = m[4] === undefined ? '' : this.#order(target, 'rows').idAt(Number(m[4]) - 1);
          out += `⟦${m[1]}${col ?? ''}|${m[3]}${row ?? ''}⟧`;
          continue;
        }
      }
      if (t.kind !== 'whitespace' && !(t.kind === 'operator' && t.text === ':')) target = sheet;
      out += t.text;
    }
    return out;
  }

  /** A formula in id form as A1 text at the current positions; a deleted id is `#REF!`. */
  #fromIdForm(formula: string, sheet: string): string {
    // The sheet each id-form reference reads: the last sheet prefix before it, if adjacent.
    let out = '';
    let last = 0;
    let previous = sheet;
    ID_FORM.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ID_FORM.exec(formula)) !== null) {
      const before = formula.slice(last, m.index);
      out += before;
      const prefix = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!$/.exec(out);
      const named = prefix === null ? undefined : (prefix[1]?.replace(/''/g, "'") ?? prefix[2]);
      // A range's second end reads the sheet its first end read.
      const target =
        named !== undefined
          ? (this.#sheetIdByName(named) ?? sheet)
          : before === ':'
            ? previous
            : sheet;
      previous = target;
      const [, colAbs, colId, rowAbs, rowId] = m;
      const col = colId === '' ? undefined : this.#order(target, 'cols').positionOf(colId);
      const row = rowId === '' ? undefined : this.#order(target, 'rows').positionOf(rowId);
      if ((colId !== '' && col === undefined) || (rowId !== '' && row === undefined)) {
        // The reference's row or column is gone: the reference is, with its sheet prefix.
        if (prefix !== null) out = out.slice(0, out.length - prefix[0].length);
        out += '#REF!';
      } else {
        out +=
          (col === undefined ? '' : `${colAbs}${columnLetters(col)}`) +
          (row === undefined ? '' : `${rowAbs}${row + 1}`);
      }
      last = m.index + m[0].length;
    }
    out += formula.slice(last);
    // A range with one end gone is gone whole.
    return out.replace(/#REF!:[$A-Za-z0-9]+|[$A-Za-z0-9]+:#REF!|#REF!:#REF!/g, '#REF!');
  }

  // ------------------------------------------------------------ local to Loro

  /** The whole model into an empty document. */
  #seed(): void {
    const json = this.model.toJSON();
    const list = this.#sheetsList();
    for (const sheet of json.sheets) {
      list.push(sheet.id);
      this.#writeSheet(sheet, json.styles ?? [{}]);
    }
    this.doc.commit({ origin: LOCAL });
  }

  #writeSheet(sheet: CellsSheet, styles: readonly Style[]): void {
    const map = this.#sheetMap(sheet.id);
    map.set('name', sheet.name);
    map.set('frozen', sheet.frozen ?? { rows: 0, cols: 0 });
    this.#axisMap(sheet.id, 'rows');
    this.#axisMap(sheet.id, 'cols');
    if (sheet.dataSource !== undefined)
      map.set(
        'dataSource',
        this.#dataSourceToIds(
          {
            id: sheet.dataSource.id,
            at: { row: sheet.dataSource.row, col: sheet.dataSource.col },
            rows: sheet.dataSource.rows,
            cols: sheet.dataSource.cols,
          },
          sheet.id,
        ),
      );
    const cells = this.#cells(sheet.id);
    for (const [r, row] of Object.entries(sheet.rows))
      for (const [c, cell] of Object.entries(row.cells)) {
        const stored: StoredCell = {};
        if (cell.v !== undefined && cell.f === undefined) stored.v = cell.v;
        if (cell.f !== undefined) stored.f = this.#toIdForm(cell.f, sheet.id);
        if (cell.s !== undefined && cell.s !== 0) stored.s = styles[cell.s];
        cells.set(`${implicitId(Number(r))}.${implicitId(Number(c))}`, stored);
      }
    for (const axis of ['rows', 'cols'] as const) {
      const sizes = this.#sizes(sheet.id, axis);
      for (const [i, px] of Object.entries(sheet.sizes?.[axis] ?? {}))
        sizes.set(implicitId(Number(i)), px);
      const hidden = this.#hidden(sheet.id, axis);
      for (const i of sheet.hidden?.[axis] ?? []) hidden.set(implicitId(i), true);
    }
    this.#writeMerges(sheet.id, [], sheet.merges ?? []);
    for (const chart of Object.values(sheet.charts ?? {})) this.#writeChart(sheet.id, null, chart);
    const code = this.#code(sheet.id);
    for (const [ref, c] of Object.entries(sheet.code ?? {})) {
      const m = /^([A-Z]+)([0-9]+)$/.exec(ref)!;
      let col = -1;
      for (const ch of m[1]) col = (col + 1) * 26 + ch.charCodeAt(0) - 65;
      code.set(`${implicitId(Number(m[2]) - 1)}.${implicitId(col)}`, c);
    }
  }

  // ------------------------------------------------------------ charts

  /** A reference of a chart in id form; a name that is text stays text. */
  #refToIds(ref: string, sheet: string): string {
    return refAst(ref) === undefined ? ref : this.#toIdForm(ref, sheet);
  }

  #seriesToIds(s: ChartSeries, sheet: string): Record<string, unknown> {
    const out: Record<string, unknown> = { values: this.#toIdForm(s.values, sheet) };
    if (s.name !== undefined) out.name = this.#refToIds(s.name, sheet);
    if (s.categories !== undefined) out.categories = this.#toIdForm(s.categories, sheet);
    if (s.x !== undefined) out.x = this.#toIdForm(s.x, sheet);
    if (s.type !== undefined) out.type = s.type;
    if (s.axis !== undefined) out.axis = s.axis;
    if (s.color !== undefined) out.color = s.color;
    return out;
  }

  #dataSourceToIds(b: DataSourceBinding, sheet: string): Record<string, string | number> {
    return {
      id: b.id,
      r: this.#order(sheet, 'rows').idAt(b.at.row)!,
      c: this.#order(sheet, 'cols').idAt(b.at.col)!,
      rows: b.rows,
      cols: b.cols,
    };
  }

  /** A sheet's data source binding at the current positions; dropped when its anchor's row or column is gone. */
  #readDataSource(sheet: string): CellsSheet['dataSource'] | undefined {
    const raw = this.#sheetMap(sheet).get('dataSource') as
      { id: string; r: string; c: string; rows: number; cols: number } | undefined;
    if (raw === undefined || typeof raw !== 'object' || typeof raw.id !== 'string')
      return undefined;
    const row = this.#order(sheet, 'rows').positionOf(raw.r);
    const col = this.#order(sheet, 'cols').positionOf(raw.c);
    if (row === undefined || col === undefined) return undefined;
    if (row + raw.rows > this.#count('rows') || col + raw.cols > this.#count('cols'))
      return undefined;
    return { id: raw.id, row, col, rows: raw.rows, cols: raw.cols };
  }

  #anchorToIds(a: ChartAnchor, sheet: string): Record<string, unknown> {
    if (a.kind === 'absolute') return { ...a };
    const rows = this.#order(sheet, 'rows');
    const cols = this.#order(sheet, 'cols');
    const corner = (c: { row: number; col: number; dx: number; dy: number }) => ({
      r: rows.idAt(c.row)!,
      c: cols.idAt(c.col)!,
      dx: c.dx,
      dy: c.dy,
    });
    if (a.kind === 'cell')
      return { kind: 'cell', from: corner(a.from), width: a.width, height: a.height };
    return { kind: 'cells', from: corner(a.from), to: corner(a.to) };
  }

  /**
   * A chart's fields into its map, field by field, so two peers changing
   * different fields both keep theirs; the series as a movable list, set
   * where they differ, moved when only their order changed.
   */
  #writeChart(sheet: string, before: ChartSpec | null, after: ChartSpec): void {
    const charts = this.#charts(sheet);
    let map = before === null ? undefined : (charts.get(after.id) as LoroMap | undefined);
    if (map === undefined || !(map instanceof LoroMap)) {
      map = charts.setContainer(after.id, new LoroMap());
      before = null;
    }
    const fields = ['type', 'variant', 'title', 'legend', 'axes', 'labels'] as const;
    for (const f of fields) {
      const value = after[f];
      if (before !== null && JSON.stringify(before[f]) === JSON.stringify(value)) continue;
      if (value === undefined) map.delete(f);
      else map.set(f, value as JsonValue);
    }
    for (const f of ['by', 'headers', 'blanks'] as const) {
      if (before !== null && JSON.stringify(before.data[f]) === JSON.stringify(after.data[f]))
        continue;
      map.set(f, after.data[f] as JsonValue);
    }
    if (before === null || JSON.stringify(before.anchor) !== JSON.stringify(after.anchor))
      map.set('anchor', this.#anchorToIds(after.anchor, sheet) as JsonValue);
    let list = map.get('series') as LoroMovableList | undefined;
    if (list === undefined || !(list instanceof LoroMovableList)) {
      list = map.setContainer('series', new LoroMovableList());
      before = null;
    }
    const want = after.data.series.map((x) => this.#seriesToIds(x, sheet));
    const have = list.toJSON() as Record<string, unknown>[];
    const key = (x: unknown) => JSON.stringify(x);
    const sameSet =
      have.length === want.length &&
      [...have.map(key)].sort().join('\n') === [...want.map(key)].sort().join('\n');
    if (sameSet) {
      // A permutation: move each series to its place, left to right.
      const current = have.map(key);
      for (let i = 0; i < want.length; i += 1) {
        const k = key(want[i]);
        const j = current.indexOf(k, i);
        if (j === i || j < 0) continue;
        list.move(j, i);
        current.splice(i, 0, ...current.splice(j, 1));
      }
      return;
    }
    const n = Math.min(have.length, want.length);
    for (let i = 0; i < n; i += 1)
      if (key(have[i]) !== key(want[i])) list.set(i, want[i] as JsonValue);
    for (let i = n; i < want.length; i += 1) list.insert(i, want[i] as JsonValue);
    if (have.length > want.length) list.delete(want.length, have.length - want.length);
  }

  /** The charts of a sheet as specs at the current positions; a deleted id is `#REF!`, an anchor whose corner is gone collapses onto its other corner. */
  #readCharts(sheet: string): Record<string, ChartSpec> {
    const out: Record<string, ChartSpec> = {};
    const rows = this.#order(sheet, 'rows');
    const cols = this.#order(sheet, 'cols');
    const rowCount = this.#count('rows');
    const colCount = this.#count('cols');
    const corner = (c: { r: string; c: string; dx: number; dy: number } | undefined) => {
      if (c === undefined) return undefined;
      const row = rows.positionOf(c.r);
      const col = cols.positionOf(c.c);
      if (row === undefined || col === undefined || row >= rowCount || col >= colCount)
        return undefined;
      return { row, col, dx: c.dx, dy: c.dy };
    };
    // A range with a deleted end is `#REF!` whole (a sheet prefix left over is dropped too).
    const back = (ref: string) => {
      const out = this.#fromIdForm(ref, sheet);
      return out.includes('#REF!') ? '#REF!' : out;
    };
    for (const [id, raw] of Object.entries(this.#charts(sheet).toJSON() as Record<string, any>)) {
      if (typeof raw !== 'object' || raw === null || typeof raw.type !== 'string') continue;
      const a = raw.anchor ?? {};
      let anchor: ChartAnchor | undefined;
      if (a.kind === 'absolute') {
        anchor = { kind: 'absolute', x: a.x, y: a.y, width: a.width, height: a.height };
      } else if (a.kind === 'cell') {
        const from = corner(a.from);
        if (from !== undefined) anchor = { kind: 'cell', from, width: a.width, height: a.height };
      } else if (a.kind === 'cells') {
        const from = corner(a.from);
        const to = corner(a.to);
        if (from !== undefined && to !== undefined)
          anchor = {
            kind: 'cells',
            from: {
              row: Math.min(from.row, to.row),
              col: Math.min(from.col, to.col),
              dx: from.dx,
              dy: from.dy,
            },
            to: {
              row: Math.max(from.row, to.row),
              col: Math.max(from.col, to.col),
              dx: to.dx,
              dy: to.dy,
            },
          };
        else if (from !== undefined) anchor = { kind: 'cells', from, to: from };
        else if (to !== undefined) anchor = { kind: 'cells', from: to, to };
      }
      if (anchor === undefined) continue; // the cells it sat on are gone
      const series: ChartSeries[] = [];
      for (const x of (Array.isArray(raw.series) ? raw.series : []) as Record<string, unknown>[]) {
        if (typeof x?.values !== 'string') continue;
        const sr: Record<string, unknown> = {};
        if (typeof x.name === 'string') sr.name = x.name.includes('⟦') ? back(x.name) : x.name;
        sr.values = back(x.values);
        if (typeof x.categories === 'string') sr.categories = back(x.categories);
        if (typeof x.x === 'string') sr.x = back(x.x);
        for (const k of ['type', 'axis', 'color'] as const) if (x[k] !== undefined) sr[k] = x[k];
        series.push(sr as unknown as ChartSeries);
      }
      if (series.length === 0) continue;
      const spec: Record<string, unknown> = {
        id,
        type: raw.type,
        anchor,
        data: {
          series,
          by: raw.by ?? 'columns',
          headers: raw.headers ?? { row: false, column: false },
          blanks: raw.blanks ?? 'gap',
        },
        legend: raw.legend ?? 'bottom',
      };
      for (const f of ['variant', 'title', 'axes', 'labels'] as const)
        if (raw[f] !== undefined) spec[f] = raw[f];
      out[id] = spec as unknown as ChartSpec;
    }
    return out;
  }

  /** Merges keyed by their top-left corner's ids: those gone are deleted, those new set. */
  #mergeCorners(sheet: string): (z: Zone) => { r0: string; c0: string; r1: string; c1: string } {
    const rows = this.#order(sheet, 'rows');
    const cols = this.#order(sheet, 'cols');
    return (z: Zone) => ({
      r0: rows.idAt(z.top)!,
      c0: cols.idAt(z.left)!,
      r1: rows.idAt(z.bottom)!,
      c1: cols.idAt(z.right)!,
    });
  }

  /**
   * `before`'s keys are read on the order as it is now, unless given: a merges
   * patch a delete made reads its `before` on the order before the delete and
   * its `after` on the order after it.
   */
  #writeMerges(
    sheet: string,
    before: readonly Zone[],
    after: readonly Zone[],
    beforeKeys?: readonly string[],
  ): void {
    const m = this.#merges(sheet);
    const corners = this.#mergeCorners(sheet);
    const keyOf = (c: { r0: string; c0: string }) => `${c.r0}.${c.c0}`;
    const kept = new Set(after.map((z) => keyOf(corners(z))));
    for (const k of beforeKeys ?? before.map((z) => keyOf(corners(z))))
      if (!kept.has(k)) m.delete(k);
    for (const z of after) {
      const c = corners(z);
      m.set(keyOf(c), c);
    }
  }

  #local(tx: Transaction): void {
    if (this.#projecting) return;
    if (tx.origin !== 'local' && tx.origin !== 'undo' && tx.origin !== 'redo') return;
    const patches = tx.patches;
    // What runs right after the patch at an index: the second half of a merges patch a delete made.
    const after = new Map<number, () => void>();
    for (let i = 0; i < patches.length; i += 1) {
      const p = patches[i];
      const sheet = (p as { sheet?: unknown }).sheet;
      if (typeof sheet === 'string' && p.op !== 'sheet-add') this.#ensureSheet(sheet);
      if (p.op === 'cells' && this.#movedCells(p, patches)) continue;
      const j = p.op === 'merges' ? this.#axisDeleteAfter(patches, i) : -1;
      if (j >= 0) {
        // The model's `after` is on the positions after the delete, its `before` on those before it.
        const a = p as Patch & { sheet: string; before: readonly Zone[]; after: readonly Zone[] };
        const corners = this.#mergeCorners(a.sheet);
        const keys = a.before.map((z) => {
          const c = corners(z);
          return `${c.r0}.${c.c0}`;
        });
        after.set(j, () => this.#writeMerges(a.sheet, a.before, a.after, keys));
        continue;
      }
      this.#patch(p);
      after.get(i)?.();
    }
    this.doc.commit({ origin: LOCAL });
  }

  /**
   * A move's cells patch, which only carries the cells to their new positions:
   * on ids the move itself carries them (the rows keep their ids), so writing
   * it would move them a second time.
   */
  #movedCells(p: Patch, patches: readonly Patch[]): boolean {
    const c = p as CellsPatch;
    return patches.some((q) => {
      if (q.op !== 'axis-move') return false;
      const a = q as Patch & { sheet: string; axis: AxisName; at: number; n: number; to: number };
      if (a.sheet !== c.sheet) return false;
      const sheet = this.model.sheet(a.sheet);
      const lo = Math.min(a.at, a.to);
      const hi = Math.max(a.at + a.n, a.to) - 1;
      const z = c.zone;
      return a.axis === 'rows'
        ? z.top === lo && z.bottom === hi && z.left === 0 && z.right === sheet.cols.count - 1
        : z.left === lo && z.right === hi && z.top === 0 && z.bottom === sheet.rows.count - 1;
    });
  }

  /** The index of an axis delete on the same sheet after a merges patch, or -1. */
  #axisDeleteAfter(patches: readonly Patch[], i: number): number {
    const sheet = (patches[i] as { sheet?: unknown }).sheet;
    for (let j = i + 1; j < patches.length; j += 1)
      if (patches[j].op === 'axis-delete' && (patches[j] as { sheet?: unknown }).sheet === sheet)
        return j;
    return -1;
  }

  #patch(p: Patch): void {
    const m = this.model;
    switch (p.op) {
      case 'cells': {
        const c = p as CellsPatch;
        const rows = this.#order(c.sheet, 'rows');
        const cols = this.#order(c.sheet, 'cols');
        const cells = this.#cells(c.sheet);
        const key = (r: number, col: number) => `${rows.idAt(r)}.${cols.idAt(col)}`;
        for (const [r, col] of snapshotEntries(c.before)) cells.delete(key(r, col));
        for (const [r, col, content] of snapshotEntries(c.after)) {
          const stored: StoredCell = {};
          if (content.formula !== undefined) stored.f = this.#toIdForm(content.formula, c.sheet);
          else if (content.value !== null)
            stored.v = isCellError(content.value) ? { error: content.value.error } : content.value;
          if (content.style !== 0) stored.s = m.workbook.styles.get(content.style);
          cells.set(key(r, col), stored);
        }
        return;
      }
      case 'axis-insert': {
        const a = p as Patch & { sheet: string; axis: AxisName; at: number; n: number };
        insert(
          this.#axisMap(a.sheet, a.axis),
          this.#count(a.axis),
          a.at,
          a.n,
          this.#peer,
          this.#counter,
        );
        return;
      }
      case 'axis-delete': {
        const a = p as Patch & { sheet: string; axis: AxisName; at: number; n: number };
        remove(this.#axisMap(a.sheet, a.axis), this.#count(a.axis), a.at, a.n);
        return;
      }
      case 'axis-move': {
        const a = p as Patch & { sheet: string; axis: AxisName; at: number; n: number; to: number };
        move(
          this.#axisMap(a.sheet, a.axis),
          this.#count(a.axis),
          a.at,
          a.n,
          a.to,
          this.#peer,
          this.#counter,
        );
        return;
      }
      case 'axis-sizes': {
        const a = p as Patch & { sheet: string; axis: AxisName; at: number; n: number };
        const sheet = m.sheet(a.sheet);
        const axis = a.axis === 'rows' ? sheet.rows : sheet.cols;
        const order = this.#order(a.sheet, a.axis);
        const sizes = this.#sizes(a.sheet, a.axis);
        const hidden = this.#hidden(a.sheet, a.axis);
        for (let i = a.at; i < a.at + a.n; i += 1) {
          const id = order.idAt(i)!;
          if (axis.sizeOf(i) === axis.defaultSize) sizes.delete(id);
          else sizes.set(id, axis.sizeOf(i));
          if (axis.isHidden(i)) hidden.set(id, true);
          else hidden.delete(id);
        }
        return;
      }
      case 'merges': {
        const a = p as Patch & { sheet: string; before: readonly Zone[]; after: readonly Zone[] };
        this.#writeMerges(a.sheet, a.before, a.after);
        return;
      }
      case 'frozen': {
        const a = p as Patch & { sheet: string; after: { rows: number; cols: number } };
        this.#sheetMap(a.sheet).set('frozen', a.after);
        return;
      }
      case 'dataSource': {
        // The binding on ids: a peer's insert above the anchor leaves it on the same cell.
        const a = p as unknown as DataSourcePatch;
        if (a.after === null) this.#sheetMap(a.sheet).delete('dataSource');
        else this.#sheetMap(a.sheet).set('dataSource', this.#dataSourceToIds(a.after, a.sheet));
        return;
      }
      case 'code': {
        const c = p as unknown as CodePatch;
        const at = codePosition(m.sheet(c.sheet), c.key);
        if (at === undefined) return;
        const key = `${this.#order(c.sheet, 'rows').idAt(at.row)}.${this.#order(c.sheet, 'cols').idAt(at.col)}`;
        if (c.after === null) this.#code(c.sheet).delete(key);
        else this.#code(c.sheet).set(key, c.after);
        return;
      }
      case 'chart': {
        const a = p as unknown as ChartPatch;
        // A delete wins over a concurrent edit: the map goes, and an edit of a gone chart recreates nothing.
        if (a.after === null) this.#charts(a.sheet).delete(a.id);
        else if (a.before !== null && this.#charts(a.sheet).get(a.id) === undefined) return;
        else this.#writeChart(a.sheet, a.before, a.after);
        return;
      }
      case 'sheet-add': {
        const a = p as Patch & { index: number; sheet: { id: string } };
        // The sheets before it that the document lacks (the empty sheet two concurrent deletes
        // left) go back first, so the index the model gave is one the list has.
        for (const s of m.sheets.slice(0, a.index)) this.#ensureSheet(s.id);
        this.#sheetsList().insert(a.index, a.sheet.id);
        const json = m.toJSON();
        this.#writeSheet(
          json.sheets.find((s) => s.id === a.sheet.id)!,
          json.styles ?? [{}],
        );
        return;
      }
      case 'sheet-delete': {
        const a = p as Patch & { sheet: { id: string } };
        const list = this.#sheetsList();
        const i = (list.toJSON() as string[]).indexOf(a.sheet.id);
        if (i >= 0) list.delete(i, 1);
        return;
      }
      case 'sheet-rename': {
        const a = p as Patch & { sheet: string; after: string };
        this.#sheetMap(a.sheet).set('name', a.after);
        return;
      }
      case 'sheet-move': {
        const a = p as Patch & { from: number; to: number };
        this.#sheetsList().move(a.from, a.to);
        return;
      }
      default:
        throw new Error(`The collaboration binding does not translate the patch op '${p.op}'.`);
    }
  }

  /** A sheet written to but missing from the document's list (the empty sheet): put it back. */
  #ensureSheet(id: string): void {
    const list = this.#sheetsList();
    if ((list.toJSON() as string[]).includes(id)) return;
    list.push(id);
    const map = this.#sheetMap(id);
    if (map.get('name') === undefined) map.set('name', this.model.sheet(id).name);
  }

  // ------------------------------------------------------------ Loro to local

  /** The document as a workbook, positions from the axes' orders. */
  #workbook(): CellsWorkbook {
    const styles: Style[] = [{}];
    const styleIndex = new Map<string, number>([['{}', 0]]);
    const style = (s: Style | undefined) => {
      if (s === undefined) return 0;
      const key = JSON.stringify(s);
      let i = styleIndex.get(key);
      if (i === undefined) {
        i = styles.length;
        styles.push(s);
        styleIndex.set(key, i);
      }
      return i;
    };
    let ids = [...new Set(this.#sheetsList().toJSON() as string[])];
    // Two peers each deleting the other's last sheet leave none: every peer shows the same empty
    // sheet then, under one id, and the first write to it puts it back in the document.
    if (ids.length === 0) ids = [EMPTY_SHEET];
    const names = new Map(
      ids.map((id) => [id, (this.#sheetMap(id).get('name') as string | undefined) ?? 'Sheet1']),
    );
    const sheets: CellsSheet[] = ids.map((id) => {
      const map = this.#sheetMap(id);
      const rows = this.#order(id, 'rows');
      const cols = this.#order(id, 'cols');
      const out: Record<
        string,
        { cells: Record<string, { v?: JsonValue; f?: string; s?: number }> }
      > = {};
      for (const [key, value] of Object.entries(
        this.#cells(id).toJSON() as Record<string, StoredCell>,
      )) {
        const dot = key.indexOf('.');
        const r = rows.positionOf(key.slice(0, dot));
        const c = cols.positionOf(key.slice(dot + 1));
        if (
          r === undefined ||
          c === undefined ||
          r >= this.#count('rows') ||
          c >= this.#count('cols')
        )
          continue;
        const cell: { v?: JsonValue; f?: string; s?: number } = {};
        if (value.f !== undefined) cell.f = value.f;
        else if (value.v !== undefined) cell.v = value.v;
        const s = style(value.s);
        if (s !== 0) cell.s = s;
        if (cell.v === undefined && cell.f === undefined && cell.s === undefined) continue;
        (out[String(r)] ??= { cells: {} }).cells[String(c)] = cell;
      }
      const axisRecord = (container: 'sizes' | 'hidden', axis: AxisName, order: AxisOrder) => {
        const m = container === 'sizes' ? this.#sizes(id, axis) : this.#hidden(id, axis);
        const entries = Object.entries(m.toJSON() as Record<string, number | boolean>);
        return entries
          .map(([k, v]) => [order.positionOf(k), v] as const)
          .filter(([i]) => i !== undefined && i < this.#count(axis)) as [
          number,
          number | boolean,
        ][];
      };
      const sizes = {
        rows: Object.fromEntries(
          axisRecord('sizes', 'rows', rows).map(([i, v]) => [String(i), v as number]),
        ),
        cols: Object.fromEntries(
          axisRecord('sizes', 'cols', cols).map(([i, v]) => [String(i), v as number]),
        ),
      };
      const hidden = {
        rows: axisRecord('hidden', 'rows', rows).map(([i]) => i),
        cols: axisRecord('hidden', 'cols', cols).map(([i]) => i),
      };
      const merges: Zone[] = [];
      for (const corners of Object.values(
        this.#merges(id).toJSON() as Record<string, Record<string, string>>,
      )) {
        const top = rows.positionOf(corners.r0);
        const left = cols.positionOf(corners.c0);
        const bottom = rows.positionOf(corners.r1);
        const right = cols.positionOf(corners.c1);
        if (top === undefined || left === undefined || bottom === undefined || right === undefined)
          continue;
        // Rows moved by peers may have turned the corners round: the merge is what they span.
        const zone = {
          top: Math.min(top, bottom),
          left: Math.min(left, right),
          bottom: Math.max(top, bottom),
          right: Math.max(left, right),
        };
        const inside = zone.bottom < this.#count('rows') && zone.right < this.#count('cols');
        if (inside && (zone.top !== zone.bottom || zone.left !== zone.right)) merges.push(zone);
      }
      const charts = this.#readCharts(id);
      const dataSource = this.#readDataSource(id);
      const code: Record<string, CodeCell> = {};
      for (const [key, c] of Object.entries(this.#code(id).toJSON() as Record<string, CodeCell>)) {
        const dot = key.indexOf('.');
        const r = rows.positionOf(key.slice(0, dot));
        const col = cols.positionOf(key.slice(dot + 1));
        if (
          r === undefined ||
          col === undefined ||
          r >= this.#count('rows') ||
          col >= this.#count('cols')
        )
          continue;
        code[codeRef(r, col)] = c;
      }
      return {
        id,
        name: names.get(id) ?? id,
        rows: out,
        sizes,
        hidden,
        merges: disjoint(merges),
        ...(Object.keys(charts).length > 0 ? { charts } : {}),
        ...(Object.keys(code).length > 0 ? { code } : {}),
        ...(dataSource !== undefined ? { dataSource } : {}),
        frozen: (map.get('frozen') as { rows: number; cols: number } | undefined) ?? {
          rows: 0,
          cols: 0,
        },
      };
    });
    // Formulas back from id form, once every sheet's name and order is known.
    for (const sheet of sheets)
      for (const row of Object.values(sheet.rows))
        for (const cell of Object.values(row.cells) as { f?: string }[])
          if (cell.f !== undefined) cell.f = this.#fromIdForm(cell.f, sheet.id);
    return { version: 1, sheets, styles };
  }

  #project(): void {
    this.#projecting = true;
    try {
      const wb = this.#workbook();
      this.model.replaceData(wb, 'remote');
    } finally {
      this.#projecting = false;
    }
  }
}

/** Merges that overlap (two peers merging across each other) keep the first of each overlap. */
function disjoint(merges: readonly Zone[]): Zone[] {
  const out: Zone[] = [];
  const sorted = [...merges].sort((a, b) => a.top - b.top || a.left - b.left);
  for (const z of sorted) {
    if (
      out.some(
        (o) => o.top <= z.bottom && z.top <= o.bottom && o.left <= z.right && z.left <= o.right,
      )
    )
      continue;
    out.push(z);
  }
  return out;
}
