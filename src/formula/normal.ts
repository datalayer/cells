/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Formulas relative to their cell. A reference without `$` is an offset from
 * the formula's cell (R1C1-relative); with `$`, an index. The same formula
 * filled down a column is then one shape, compiled once: the shape key is the
 * relative form with its constants taken out. The printer writes an AST back
 * as text, and `translateFormula` moves a formula's relative references, as
 * paste, fill and sort do.
 *
 * @module formula/normal
 */

import { columnLetters } from '../core/zone.js';
import type { Ast, RefPart } from './ast.js';
import { parseFormula } from './parser.js';

/** A reference part relative to a cell: offsets where relative, indexes where absolute. */
export interface RelPart {
  readonly row?: number;
  readonly col?: number;
  readonly rowAbs: boolean;
  readonly colAbs: boolean;
}

export function relative(p: RefPart, at: { row: number; col: number }): RelPart {
  return {
    rowAbs: p.rowAbs,
    colAbs: p.colAbs,
    ...(p.row !== undefined ? { row: p.rowAbs ? p.row : p.row - at.row } : {}),
    ...(p.col !== undefined ? { col: p.colAbs ? p.col : p.col - at.col } : {}),
  };
}

export function absolute(p: RelPart, at: { row: number; col: number }): RefPart {
  return {
    rowAbs: p.rowAbs,
    colAbs: p.colAbs,
    ...(p.row !== undefined ? { row: p.rowAbs ? p.row : p.row + at.row } : {}),
    ...(p.col !== undefined ? { col: p.colAbs ? p.col : p.col + at.col } : {}),
  };
}

const relText = (p: RelPart) =>
  `${p.row === undefined ? '' : p.rowAbs ? `R${p.row}` : `R[${p.row}]`}${p.col === undefined ? '' : p.colAbs ? `C${p.col}` : `C[${p.col}]`}`;

/**
 * The shape of a formula at a cell, and its constants: two formulas with one
 * shape compile to one function, which reads its constants from the list.
 */
export function shapeOf(
  ast: Ast,
  at: { row: number; col: number },
): { key: string; constants: (number | string)[] } {
  const constants: (number | string)[] = [];
  const walk = (a: Ast): string => {
    switch (a.type) {
      case 'number':
        constants.push(a.value);
        return '#n';
      case 'string':
        constants.push(a.value);
        return '#s';
      case 'bool':
        return a.value ? 'T' : 'F';
      case 'error':
        return a.code;
      case 'cell':
        return `${a.sheet === undefined ? '' : `'${a.sheet}'!`}${relText(relative(a.ref, at))}`;
      case 'range':
        return `${a.sheet === undefined ? '' : `'${a.sheet}'!`}${relText(relative(a.from, at))}:${relText(relative(a.to, at))}`;
      case 'name':
        return `N(${a.name.toUpperCase()})`;
      case 'call':
        return `${a.name}(${a.args.map(walk).join(',')})`;
      case 'unary':
        return `${a.op}(${walk(a.arg)})`;
      case 'percent':
        return `%(${walk(a.arg)})`;
      case 'binary':
        return `(${walk(a.left)}${a.op === ' ' ? '_' : a.op}${walk(a.right)})`;
      case 'union':
        return `U(${a.items.map(walk).join(',')})`;
      case 'array':
        return `{${a.rows.map((r) => r.map(walk).join(',')).join(';')}}`;
      case 'empty':
        return '~';
    }
  };
  return { key: walk(ast), constants };
}

const quoteSheet = (s: string) =>
  /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) && !/^[A-Za-z]{1,3}[0-9]+$/.test(s)
    ? s
    : `'${s.replace(/'/g, "''")}'`;

function partText(p: RefPart): string {
  const col = p.col === undefined ? '' : `${p.colAbs ? '$' : ''}${columnLetters(p.col)}`;
  const row = p.row === undefined ? '' : `${p.rowAbs ? '$' : ''}${p.row + 1}`;
  return col + row;
}

const PRECEDENCE: Record<string, number> = {
  '=': 10,
  '<>': 10,
  '<': 10,
  '<=': 10,
  '>': 10,
  '>=': 10,
  '&': 20,
  '+': 30,
  '-': 30,
  '*': 40,
  '/': 40,
  '^': 50,
  ' ': 80,
};

/** An AST as formula text (without the `=`), in en-US syntax. */
export function printFormula(ast: Ast): string {
  const print = (a: Ast, parent = 0): string => {
    switch (a.type) {
      case 'number':
        return String(a.value);
      case 'string':
        return `"${a.value.replace(/"/g, '""')}"`;
      case 'bool':
        return a.value ? 'TRUE' : 'FALSE';
      case 'error':
        return a.code;
      case 'cell':
        return `${a.sheet === undefined ? '' : `${quoteSheet(a.sheet)}!`}${partText(a.ref)}`;
      case 'range':
        return `${a.sheet === undefined ? '' : `${quoteSheet(a.sheet)}!`}${partText(a.from)}:${partText(a.to)}`;
      case 'name':
        return a.name;
      case 'call':
        if (a.name === ':') return `${print(a.args[0], 90)}:${print(a.args[1], 90)}`;
        return `${a.name}(${a.args.map((x) => print(x)).join(',')})`;
      case 'unary':
        return `${a.op}${print(a.arg, 60)}`;
      case 'percent':
        return `${print(a.arg, 70)}%`;
      case 'binary': {
        const p = PRECEDENCE[a.op];
        // ^ is left-associative: a right operand of equal precedence needs parentheses.
        const text = `${print(a.left, p - 0.5)}${a.op}${print(a.right, p)}`;
        return p <= parent ? `(${text})` : text;
      }
      case 'union':
        return `(${a.items.map((x) => print(x)).join(',')})`;
      case 'array':
        return `{${a.rows.map((r) => r.map((x) => print(x)).join(',')).join(';')}}`;
      case 'empty':
        return '';
    }
  };
  return print(ast);
}

/**
 * Move a formula's relative references by an offset, as pasting or filling it
 * elsewhere does. A reference moved off the sheet becomes `#REF!`.
 */
export function translateAst(
  ast: Ast,
  dRow: number,
  dCol: number,
  limits = { rows: 1_048_576, cols: 16_384 },
): Ast {
  return mapReferences(ast, limits, (p) => ({
    row: p.row === undefined || p.rowAbs ? p.row : p.row + dRow,
    col: p.col === undefined || p.colAbs ? p.col : p.col + dCol,
  }));
}

/**
 * A formula pasted transposed, from cell `from` to cell `to`: a reference
 * relative on both axes has its offsets swapped (the cell above becomes the
 * cell to the left); anchored, whole-row and whole-column references move by
 * the distance, as a plain paste moves them.
 */
export function transposeAst(
  ast: Ast,
  from: { row: number; col: number },
  to: { row: number; col: number },
  limits = { rows: 1_048_576, cols: 16_384 },
): Ast {
  return mapReferences(ast, limits, (p) => {
    if (p.row !== undefined && p.col !== undefined && !p.rowAbs && !p.colAbs)
      return { row: to.row + (p.col - from.col), col: to.col + (p.row - from.row) };
    return {
      row: p.row === undefined || p.rowAbs ? p.row : p.row + to.row - from.row,
      col: p.col === undefined || p.colAbs ? p.col : p.col + to.col - from.col,
    };
  });
}

/** Every reference part of an AST moved; one moved off the sheet turns its reference into `#REF!`. */
function mapReferences(
  ast: Ast,
  limits: { rows: number; cols: number },
  place: (p: RefPart) => { row?: number; col?: number },
): Ast {
  const move = (p: RefPart): RefPart | undefined => {
    const { row, col } = place(p);
    if (
      (row !== undefined && (row < 0 || row >= limits.rows)) ||
      (col !== undefined && (col < 0 || col >= limits.cols))
    )
      return undefined;
    return { ...p, ...(row !== undefined ? { row } : {}), ...(col !== undefined ? { col } : {}) };
  };
  const walk = (a: Ast): Ast => {
    switch (a.type) {
      case 'cell': {
        const ref = move(a.ref);
        return ref === undefined ? { type: 'error', code: '#REF!' } : { ...a, ref };
      }
      case 'range': {
        const from = move(a.from);
        const to = move(a.to);
        return from === undefined || to === undefined
          ? { type: 'error', code: '#REF!' }
          : { ...a, from, to };
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
  return walk(ast);
}

/** A formula's text pasted transposed from one cell to another (see {@link transposeAst}); text that does not parse is returned as it is. */
export function transposeFormula(
  text: string,
  from: { row: number; col: number },
  to: { row: number; col: number },
  limits?: { rows: number; cols: number },
): string {
  let ast: Ast;
  try {
    ast = parseFormula(text).ast;
  } catch {
    return text;
  }
  return printFormula(transposeAst(ast, from, to, limits));
}

/** A formula's text moved by an offset. Text that does not parse is returned as it is (it shows as an error in its cell). */
export function translateFormula(
  text: string,
  dRow: number,
  dCol: number,
  limits?: { rows: number; cols: number },
): string {
  if (dRow === 0 && dCol === 0) return text;
  let ast: Ast;
  try {
    ast = parseFormula(text).ast;
  } catch {
    return text;
  }
  return printFormula(translateAst(ast, dRow, dCol, limits));
}
