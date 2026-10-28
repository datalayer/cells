/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Patches: the only writes to a workbook. A command produces patches; undo
 * applies their inverses in reverse order, redo the patches again. Every
 * patch op declares `apply`, `invert` and an `example` (what the forcing test
 * inverts twice); a plugin's own op does the same through the
 * `datalayer.cells.patchOp` point.
 *
 * Patches are position-addressed: they live in memory, never on the wire.
 *
 * @module core/patches
 */

import type { AxisSegment } from './axis.js';
import type { CellContent } from './cells.js';
import type { CellValue } from './values.js';
import type { Frozen, Sheet, Workbook } from './workbook.js';
import type { Zone } from './zone.js';

/** `rows` or `cols`. */
export type AxisName = 'rows' | 'cols';

/**
 * The populated cells of a zone, columnar. Strings are held by value (not
 * pool indexes, which are reference-counted); styles by table index, which
 * is stable.
 */
export interface Snapshot {
  readonly rows: Int32Array;
  readonly cols: Int32Array;
  readonly values: readonly CellValue[];
  readonly formulas: readonly (string | undefined)[];
  readonly styles: Uint16Array;
}

/** The `cells` patch: a zone's populated cells before and after. */
export interface CellsPatch {
  readonly op: 'cells';
  readonly sheet: string;
  readonly zone: Zone;
  readonly before: Snapshot;
  readonly after: Snapshot;
}
export interface AxisInsertPatch {
  readonly op: 'axis-insert';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly at: number;
  readonly n: number;
  /** What is inserted (`ids` always; sizes and hidden flags when not default). */
  readonly inserted: AxisSegment;
  /** What falls off the end, brought back by the inverse; absent when it was implicit. */
  readonly dropped?: AxisSegment;
}
export interface AxisDeletePatch {
  readonly op: 'axis-delete';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly at: number;
  readonly n: number;
  readonly removed: AxisSegment;
  /** What appears at the end; absent: the implicit indexes the axis derives. */
  readonly tail?: AxisSegment;
}
export interface AxisMovePatch {
  readonly op: 'axis-move';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly at: number;
  readonly n: number;
  /** Before this index, in the coordinates before the move. */
  readonly to: number;
}
export interface AxisSizesPatch {
  readonly op: 'axis-sizes';
  readonly sheet: string;
  readonly axis: AxisName;
  readonly at: number;
  readonly n: number;
  readonly before: { readonly sizes: Float64Array | null; readonly hidden: Uint8Array | null };
  readonly after: { readonly sizes: Float64Array | null; readonly hidden: Uint8Array | null };
}
export interface MergesPatch {
  readonly op: 'merges';
  readonly sheet: string;
  readonly before: readonly Zone[];
  readonly after: readonly Zone[];
}
export interface SheetAddPatch {
  readonly op: 'sheet-add';
  readonly index: number;
  /** The sheet itself: a deleted sheet comes back as the same object, ids and all. */
  readonly sheet: Sheet;
}
export interface SheetDeletePatch {
  readonly op: 'sheet-delete';
  readonly index: number;
  readonly sheet: Sheet;
}
export interface SheetRenamePatch {
  readonly op: 'sheet-rename';
  readonly sheet: string;
  readonly before: string;
  readonly after: string;
}
export interface SheetMovePatch {
  readonly op: 'sheet-move';
  readonly from: number;
  readonly to: number;
}
export interface FrozenPatch {
  readonly op: 'frozen';
  readonly sheet: string;
  readonly before: Frozen;
  readonly after: Frozen;
}

/** The core patches. A plugin's patch is any object with an `op` its plugin registered. */
export type CorePatch =
  | CellsPatch
  | AxisInsertPatch
  | AxisDeletePatch
  | AxisMovePatch
  | AxisSizesPatch
  | MergesPatch
  | SheetAddPatch
  | SheetDeletePatch
  | SheetRenamePatch
  | SheetMovePatch
  | FrozenPatch;

/** A change as the model applies and inverts it: a core patch, or a plugin's patch op. */
export interface Patch {
  readonly op: string;
}

/** A patch op, as the `datalayer.cells.patchOp` point takes it. */
export interface PatchOp<P extends Patch = Patch> {
  readonly op: P['op'];
  apply(workbook: Workbook, patch: P): void;
  /** The patch that undoes this one; it may be of another op (an insert's is a delete). */
  invert(patch: P): Patch;
  /** A sample patch for the forcing test, valid on a workbook holding one empty sheet `s1`. */
  example(workbook: Workbook): P;
  /** An estimate of the patch's memory, for the history's cap. */
  bytes?(patch: P): number;
}

// ------------------------------------------------------------------ snapshots

/** A snapshot of no cells. */
export const EMPTY_SNAPSHOT: Snapshot = {
  rows: new Int32Array(0),
  cols: new Int32Array(0),
  values: [],
  formulas: [],
  styles: new Uint16Array(0),
};

/** The populated cells of a zone. */
export function snapshot(sheet: Sheet, zone: Zone): Snapshot {
  const rows: number[] = [];
  const cols: number[] = [];
  const values: CellValue[] = [];
  const formulas: (string | undefined)[] = [];
  const styles: number[] = [];
  for (const [row, col, c] of sheet.cells.entries(zone)) {
    rows.push(row);
    cols.push(col);
    values.push(c.value);
    formulas.push(c.formula);
    styles.push(c.style);
  }
  return {
    rows: Int32Array.from(rows),
    cols: Int32Array.from(cols),
    values,
    formulas,
    styles: Uint16Array.from(styles),
  };
}

/** A snapshot from contents listed by position. */
export function snapshotOf(cells: readonly (readonly [number, number, CellContent])[]): Snapshot {
  return {
    rows: Int32Array.from(cells, (c) => c[0]),
    cols: Int32Array.from(cells, (c) => c[1]),
    values: cells.map((c) => c[2].value),
    formulas: cells.map((c) => c[2].formula),
    styles: Uint16Array.from(cells, (c) => c[2].style),
  };
}

/** The cells of a snapshot as `[row, col, content]` triples. */
export function snapshotEntries(s: Snapshot): [number, number, CellContent][] {
  const out: [number, number, CellContent][] = [];
  for (let i = 0; i < s.rows.length; i += 1) {
    const formula = s.formulas[i];
    out.push([
      s.rows[i],
      s.cols[i],
      formula === undefined
        ? { value: s.values[i], style: s.styles[i] }
        : { value: s.values[i], formula, style: s.styles[i] },
    ]);
  }
  return out;
}

function snapshotBytes(s: Snapshot): number {
  let bytes = 64 + s.rows.length * 26;
  for (const v of s.values) if (typeof v === 'string') bytes += v.length * 2;
  for (const f of s.formulas) if (f !== undefined) bytes += f.length * 2;
  return bytes;
}

function segmentBytes(s: AxisSegment): number {
  return 64 + s.ids.byteLength + (s.sizes?.byteLength ?? 0) + (s.hidden?.byteLength ?? 0);
}

// ------------------------------------------------------------------ the core ops

const axisOf = (sheet: Sheet, axis: AxisName) => (axis === 'rows' ? sheet.rows : sheet.cols);
const segmentOf = (ids: number[]): AxisSegment => ({
  ids: Int32Array.from(ids),
  sizes: null,
  hidden: null,
});

const cellsOp: PatchOp<CellsPatch> = {
  op: 'cells',
  apply(wb, p) {
    const sheet = wb.sheet(p.sheet);
    for (const [row, col] of [...sheet.cells.entries(p.zone)]) sheet.cells.set(row, col, null);
    for (const [row, col, content] of snapshotEntries(p.after)) {
      if (row < p.zone.top || row > p.zone.bottom || col < p.zone.left || col > p.zone.right) {
        throw new Error(`A cells patch writes ${row},${col} outside its zone.`);
      }
      sheet.cells.set(row, col, content);
    }
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({
    op: 'cells',
    sheet: 's1',
    zone: { top: 0, left: 0, bottom: 1, right: 1 },
    before: EMPTY_SNAPSHOT,
    after: snapshotOf([[1, 1, { value: 42, style: 0 }]]),
  }),
  bytes: (p) => snapshotBytes(p.before) + snapshotBytes(p.after),
};

function shiftContent(sheet: Sheet, axis: AxisName, at: number, n: number): void {
  if (axis === 'rows') sheet.cells.shiftRows(at, n, sheet.rows.count);
  else sheet.cells.shiftCols(at, n, sheet.cols.count);
}

const axisInsertOp: PatchOp<AxisInsertPatch> = {
  op: 'axis-insert',
  apply(wb, p) {
    const sheet = wb.sheet(p.sheet);
    axisOf(sheet, p.axis).insert(p.at, p.n, p.inserted);
    shiftContent(sheet, p.axis, p.at, p.n);
  },
  invert: (p): AxisDeletePatch => ({
    op: 'axis-delete',
    sheet: p.sheet,
    axis: p.axis,
    at: p.at,
    n: p.n,
    removed: p.inserted,
    tail: p.dropped,
  }),
  example: (wb) => {
    const count = wb.sheet('s1').rows.count;
    return {
      op: 'axis-insert',
      sheet: 's1',
      axis: 'rows',
      at: 2,
      n: 2,
      inserted: segmentOf([1 << 30, (1 << 30) + 1]),
      dropped: segmentOf([count - 2, count - 1]),
    };
  },
  bytes: (p) => segmentBytes(p.inserted) + (p.dropped ? segmentBytes(p.dropped) : 0),
};

const axisDeleteOp: PatchOp<AxisDeletePatch> = {
  op: 'axis-delete',
  apply(wb, p) {
    const sheet = wb.sheet(p.sheet);
    axisOf(sheet, p.axis).delete(p.at, p.n, p.tail);
    shiftContent(sheet, p.axis, p.at, -p.n);
  },
  invert: (p): AxisInsertPatch => ({
    op: 'axis-insert',
    sheet: p.sheet,
    axis: p.axis,
    at: p.at,
    n: p.n,
    inserted: p.removed,
    dropped: p.tail,
  }),
  example: (wb) => {
    return {
      op: 'axis-delete',
      sheet: 's1',
      axis: 'rows',
      at: 1,
      n: 1,
      removed: segmentOf([1]),
    };
  },
  bytes: (p) => segmentBytes(p.removed) + (p.tail ? segmentBytes(p.tail) : 0),
};

const axisMoveOp: PatchOp<AxisMovePatch> = {
  op: 'axis-move',
  apply(wb, p) {
    axisOf(wb.sheet(p.sheet), p.axis).move(p.at, p.n, p.to);
  },
  invert: (p) =>
    p.to < p.at ? { ...p, at: p.to, to: p.at + p.n } : { ...p, at: p.to - p.n, to: p.at },
  example: () => ({ op: 'axis-move', sheet: 's1', axis: 'cols', at: 1, n: 2, to: 6 }),
};

const axisSizesOp: PatchOp<AxisSizesPatch> = {
  op: 'axis-sizes',
  apply(wb, p) {
    axisOf(wb.sheet(p.sheet), p.axis).setSegmentSizes(p.at, p.after.sizes, p.after.hidden, p.n);
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({
    op: 'axis-sizes',
    sheet: 's1',
    axis: 'cols',
    at: 3,
    n: 2,
    before: { sizes: null, hidden: null },
    after: { sizes: Float64Array.of(40, 50), hidden: Uint8Array.of(0, 1) },
  }),
};

const mergesOp: PatchOp<MergesPatch> = {
  op: 'merges',
  apply(wb, p) {
    wb.sheet(p.sheet).merges = p.after.map((z) => ({ ...z }));
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({
    op: 'merges',
    sheet: 's1',
    before: [],
    after: [{ top: 0, left: 0, bottom: 1, right: 2 }],
  }),
};

const sheetAddOp: PatchOp<SheetAddPatch> = {
  op: 'sheet-add',
  apply(wb, p) {
    if (wb.hasSheet(p.sheet.id))
      throw new Error(`Sheet '${p.sheet.id}' is in the workbook already.`);
    if (p.index < 0 || p.index > wb.sheets.length) throw new Error(`No sheet position ${p.index}.`);
    wb.sheets.splice(p.index, 0, p.sheet);
  },
  invert: (p): SheetDeletePatch => ({ op: 'sheet-delete', index: p.index, sheet: p.sheet }),
  example: (wb) => ({ op: 'sheet-add', index: 1, sheet: wb.createSheet('Example', 'example') }),
};

const sheetDeleteOp: PatchOp<SheetDeletePatch> = {
  op: 'sheet-delete',
  apply(wb, p) {
    if (wb.sheets[p.index] !== p.sheet)
      throw new Error(`Sheet '${p.sheet.id}' is not at position ${p.index}.`);
    wb.sheets.splice(p.index, 1);
  },
  invert: (p): SheetAddPatch => ({ op: 'sheet-add', index: p.index, sheet: p.sheet }),
  example: (wb) => ({ op: 'sheet-delete', index: 0, sheet: wb.sheet('s1') }),
};

const sheetRenameOp: PatchOp<SheetRenamePatch> = {
  op: 'sheet-rename',
  apply(wb, p) {
    wb.sheet(p.sheet).name = p.after;
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({ op: 'sheet-rename', sheet: 's1', before: 'Sheet1', after: 'Budget' }),
};

const sheetMoveOp: PatchOp<SheetMovePatch> = {
  op: 'sheet-move',
  apply(wb, p) {
    const [sheet] = wb.sheets.splice(p.from, 1);
    if (sheet === undefined) throw new Error(`No sheet at position ${p.from}.`);
    wb.sheets.splice(p.to, 0, sheet);
  },
  invert: (p) => ({ ...p, from: p.to, to: p.from }),
  example: () => ({ op: 'sheet-move', from: 0, to: 0 }),
};

const frozenOp: PatchOp<FrozenPatch> = {
  op: 'frozen',
  apply(wb, p) {
    wb.sheet(p.sheet).frozen = { ...p.after };
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({
    op: 'frozen',
    sheet: 's1',
    before: { rows: 0, cols: 0 },
    after: { rows: 1, cols: 2 },
  }),
};

/** The core patch ops, contributed by `CellsCorePlugin`. */
export const CORE_PATCH_OPS: readonly PatchOp<any>[] = [
  cellsOp,
  axisInsertOp,
  axisDeleteOp,
  axisMoveOp,
  axisSizesOp,
  mergesOp,
  sheetAddOp,
  sheetDeleteOp,
  sheetRenameOp,
  sheetMoveOp,
  frozenOp,
];
