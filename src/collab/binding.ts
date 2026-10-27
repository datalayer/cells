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
import type { CellsPatch, Patch } from '../core/patches.js';
import { snapshotEntries } from '../core/patches.js';
import type { Style } from '../core/styles.js';
import { isCellError } from '../core/values.js';
import type { Zone } from '../core/zone.js';
import { tokenize } from '../formula/tokens.js';
import { AxisOrder, implicitId, insert, move, remove } from './axis.js';

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

export interface BindingOptions {
  /** This peer's name in the ids it makes (`p<peer>-<n>`): unique among the peers of a document. */
  readonly peer: string;
}

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
    const cells = this.#cells(sheet.id);
    for (const [r, row] of Object.entries(sheet.rows))
      for (const [c, cell] of Object.entries(row.cells)) {
        const stored: StoredCell = {};
        if (cell.v !== undefined && cell.f === undefined) stored.v = cell.v;
        if (cell.f !== undefined) stored.f = this.#toIdForm(cell.f, sheet.id);
        if (cell.s !== undefined && cell.s !== 0) stored.s = styles[cell.s];
        cells.set(`${implicitId(Number(r))}.${implicitId(Number(c))}`, stored);
      }
    const sizes = map.setContainer('sizes', new LoroMap());
    for (const axis of ['rows', 'cols'] as const) {
      const m = sizes.setContainer(axis, new LoroMap());
      for (const [i, px] of Object.entries(sheet.sizes?.[axis] ?? {}))
        m.set(implicitId(Number(i)), px);
    }
    const hidden = map.setContainer('hidden', new LoroMap());
    for (const axis of ['rows', 'cols'] as const) {
      const m = hidden.setContainer(axis, new LoroMap());
      for (const i of sheet.hidden?.[axis] ?? []) m.set(implicitId(i), true);
    }
    this.#writeMerges(sheet.id, sheet.merges ?? []);
  }

  #writeMerges(sheet: string, merges: readonly Zone[]): void {
    const map = this.#sheetMap(sheet);
    const m = map.setContainer('merges', new LoroMap());
    const rows = this.#order(sheet, 'rows');
    const cols = this.#order(sheet, 'cols');
    merges.forEach((z) => {
      const corners = {
        r0: rows.idAt(z.top),
        c0: cols.idAt(z.left),
        r1: rows.idAt(z.bottom),
        c1: cols.idAt(z.right),
      };
      m.set(`${corners.r0}.${corners.c0}`, corners);
    });
  }

  #local(tx: Transaction): void {
    if (this.#projecting) return;
    if (tx.origin !== 'local' && tx.origin !== 'undo' && tx.origin !== 'redo') return;
    for (const p of tx.patches) this.#patch(p);
    this.doc.commit({ origin: LOCAL });
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
        move(this.#axisMap(a.sheet, a.axis), this.#count(a.axis), a.at, a.n, a.to);
        return;
      }
      case 'axis-sizes': {
        const a = p as Patch & { sheet: string; axis: AxisName; at: number; n: number };
        const sheet = m.sheet(a.sheet);
        const axis = a.axis === 'rows' ? sheet.rows : sheet.cols;
        const order = this.#order(a.sheet, a.axis);
        const sizes = (this.#sheetMap(a.sheet).get('sizes') as LoroMap).get(a.axis) as LoroMap;
        const hidden = (this.#sheetMap(a.sheet).get('hidden') as LoroMap).get(a.axis) as LoroMap;
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
        const a = p as Patch & { sheet: string; after: readonly Zone[] };
        this.#writeMerges(a.sheet, a.after);
        return;
      }
      case 'frozen': {
        const a = p as Patch & { sheet: string; after: { rows: number; cols: number } };
        this.#sheetMap(a.sheet).set('frozen', a.after);
        return;
      }
      case 'sheet-add': {
        const a = p as Patch & { index: number; sheet: { id: string } };
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
    const ids = [...new Set(this.#sheetsList().toJSON() as string[])];
    const names = new Map(ids.map((id) => [id, this.#sheetMap(id).get('name') as string]));
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
      const axisRecord = (container: string, axis: AxisName, order: AxisOrder) => {
        const m = (map.get(container) as LoroMap | undefined)?.get(axis) as LoroMap | undefined;
        const entries = Object.entries((m?.toJSON() ?? {}) as Record<string, number | boolean>);
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
      const mergesMap = map.get('merges') as LoroMap | undefined;
      for (const corners of Object.values(
        (mergesMap?.toJSON() ?? {}) as Record<string, Record<string, string>>,
      )) {
        const top = rows.positionOf(corners.r0);
        const left = cols.positionOf(corners.c0);
        const bottom = rows.positionOf(corners.r1);
        const right = cols.positionOf(corners.c1);
        if (top === undefined || left === undefined || bottom === undefined || right === undefined)
          continue;
        merges.push({ top, left, bottom, right });
      }
      return {
        id,
        name: names.get(id) ?? id,
        rows: out,
        sizes,
        hidden,
        merges: disjoint(merges),
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
      if (wb.sheets.length === 0) return;
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
