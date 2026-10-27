/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Formulas follow the rows and columns they point at, as in Excel: inserting
 * rows above `A5` turns `=A5` into `=A7`; deleting the row of `A5` turns it
 * into `#REF!`; a range keeps what survives of it (`SUM(A1:A9)` with rows 3
 * and 4 deleted is `SUM(A1:A7)`); anchored references move too (`$` anchors a
 * reference against copying, not against inserting). The commands inserting,
 * deleting and moving rows and columns add these rewrites as `cells` patches,
 * so undo restores the formulas as typed.
 *
 * @module formula/structure
 */

import type { CellContent } from '../core/cells.js';
import type { Patch } from '../core/patches.js';
import { snapshotOf } from '../core/patches.js';
import type { Workbook } from '../core/workbook.js';
import type { Ast, RefPart } from './ast.js';
import { printFormula } from './normal.js';
import { parseFormula } from './parser.js';

/** What happened on one axis of a sheet. */
export type AxisChange =
  | { readonly kind: 'insert'; readonly at: number; readonly n: number }
  | { readonly kind: 'delete'; readonly at: number; readonly n: number }
  /** Indexes `at … at+n-1` moved before index `to` (counted before the move). */
  | { readonly kind: 'move'; readonly at: number; readonly n: number; readonly to: number };

/** Where an index goes, or `undefined` when it is deleted. */
export function placeIndex(change: AxisChange, i: number): number | undefined {
  const { at, n } = change;
  switch (change.kind) {
    case 'insert':
      return i >= at ? i + n : i;
    case 'delete':
      return i < at ? i : i < at + n ? undefined : i - n;
    case 'move': {
      const { to } = change;
      if (i >= at && i < at + n) return to < at ? to + (i - at) : to - n + (i - at);
      if (to < at && i >= to && i < at) return i + n;
      if (to > at && i >= at + n && i < to) return i - n;
      return i;
    }
  }
}

/**
 * A formula's AST after an axis change. `affected` says whether a reference's
 * sheet (its name as written, `undefined` for the formula's own sheet) is the
 * one that changed.
 */
export function adjustAst(
  ast: Ast,
  affected: (sheet: string | undefined) => boolean,
  axis: 'rows' | 'cols',
  change: AxisChange,
): Ast {
  const field = axis === 'rows' ? 'row' : 'col';
  const REF: Ast = { type: 'error', code: '#REF!' };
  const with_ = (p: RefPart, v: number): RefPart => ({ ...p, [field]: v });
  let moved = false;
  const walk = (a: Ast): Ast => {
    switch (a.type) {
      case 'cell': {
        const i = a.ref[field];
        if (!affected(a.sheet) || i === undefined) return a;
        const j = placeIndex(change, i);
        if (j === i) return a;
        moved = true;
        return j === undefined ? REF : { ...a, ref: with_(a.ref, j) };
      }
      case 'range': {
        const s = a.from[field];
        const e = a.to[field];
        if (!affected(a.sheet) || s === undefined || e === undefined) return a;
        const lo = Math.min(s, e);
        const hi = Math.max(s, e);
        let start: number;
        let end: number;
        if (change.kind === 'delete') {
          // What survives of the range: its ends move to the nearest rows kept.
          start =
            lo >= change.at && lo < change.at + change.n ? change.at : placeIndex(change, lo)!;
          end =
            hi >= change.at && hi < change.at + change.n ? change.at - 1 : placeIndex(change, hi)!;
          if (start > end) {
            moved = true;
            return REF;
          }
        } else {
          const x = placeIndex(change, lo)!;
          const y = placeIndex(change, hi)!;
          start = Math.min(x, y);
          end = Math.max(x, y);
        }
        const [from, to] = s <= e ? [a.from, a.to] : [a.to, a.from];
        if (start === lo && end === hi && s <= e) return a;
        moved = true;
        return { ...a, from: with_(from, start), to: with_(to, end) };
      }
      case 'call':
        return { ...a, args: a.args.map(walk) };
      case 'unary':
      case 'percent':
        return { ...a, arg: walk(a.arg) };
      case 'binary':
        return { ...a, left: walk(a.left), right: walk(a.right) };
      case 'union':
        return { ...a, items: a.items.map(walk) };
      default:
        return a;
    }
  };
  const out = walk(ast);
  // Unchanged formulas keep their AST, so their text is not rewritten.
  return moved ? out : ast;
}

/**
 * The `cells` patches rewriting every formula of the workbook that points into
 * `sheet` across an axis change, at the positions the formulas hold once the
 * change is applied. They go after the command's axis patches.
 */
export function formulaPatches(
  workbook: Workbook,
  sheet: string,
  axis: 'rows' | 'cols',
  change: AxisChange,
): Patch[] {
  const changed = workbook.sheet(sheet);
  const name = changed.name.toLowerCase();
  const out: Patch[] = [];
  for (const s of workbook.sheets) {
    const own = s.id === sheet;
    const affected = (ref: string | undefined) =>
      ref === undefined ? own : ref.toLowerCase() === name;
    for (const [row, col, content] of s.cells.entries()) {
      if (content.formula === undefined) continue;
      let ast: Ast;
      try {
        ast = parseFormula(content.formula).ast;
      } catch {
        continue; // Text that does not parse has no references to move.
      }
      const adjusted = adjustAst(ast, affected, axis, change);
      if (adjusted === ast) continue;
      const formula = printFormula(adjusted);
      let r = row;
      let c = col;
      if (own) {
        const placed = placeIndex(change, axis === 'rows' ? row : col);
        if (placed === undefined) continue; // The formula's own row or column is deleted.
        if (axis === 'rows') r = placed;
        else c = placed;
      }
      const after: CellContent = { ...content, formula, value: null };
      out.push({
        op: 'cells',
        sheet: s.id,
        zone: { top: r, left: c, bottom: r, right: c },
        before: snapshotOf([[r, c, content]]),
        after: snapshotOf([[r, c, after]]),
      } as Patch);
    }
  }
  return out;
}
