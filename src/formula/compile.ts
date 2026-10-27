/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The compiler: a formula's AST, relative to its cell, into a tree of
 * closures. No `eval` and no `new Function`, so a page with
 * `script-src 'self'` evaluates formulas. One compiled shape serves every
 * cell holding that shape: references are offsets from the cell being
 * evaluated, and literals are read from the cell's constants, in the order
 * `shapeOf` lists them.
 *
 * @module formula/compile
 */

import { type CellError, type CellValue, isCellError } from '../core/values.js';
import type { Zone } from '../core/zone.js';
import type { FormulaFunction, FunctionArgument, FunctionContext } from '../points/index.js';
import type { Ast } from './ast.js';
import { relative, type RelPart } from './normal.js';
import {
  compare,
  err,
  ErrorValue,
  isMatrix,
  isReference,
  isUnion,
  type Reference,
  toNumber,
  toText,
  type Value,
} from './values.js';

/** What a compiled formula reads: where it is evaluated, its constants, and the cells around it. */
export interface Evaluation {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  /** The cell's constants from index 1 on, in `shapeOf` order (index 0 is the engine's). */
  readonly constants: readonly unknown[];
  readonly context: FunctionContext;
  /**
   * An asynchronous function's value: what it resolved to for these
   * arguments, or `#BUSY!` while it runs (started once; its cell and their
   * dependents recalculate when it settles).
   */
  awaited(name: string, args: readonly unknown[], run: () => unknown): CellValue;
}

export type Compiled = (e: Evaluation) => Value;

/** Turn a thrown error value into a value; anything else is a bug and goes on up. */
function caught(error: unknown): CellError {
  if (error instanceof ErrorValue) return error.value;
  throw error;
}

/**
 * A value as one cell's value: a reference to one cell is read; a range by
 * implicit intersection with the formula's row or column (else `#VALUE!`); an
 * array by its first element.
 */
export function scalar(v: Value, e: Evaluation): CellValue {
  if (isReference(v)) {
    const z = v.zone;
    if (z.top === z.bottom && z.left === z.right) return e.context.cell(v.sheet, z.top, z.left);
    if (v.sheet === e.sheet) {
      if (z.left === z.right && e.row >= z.top && e.row <= z.bottom)
        return e.context.cell(v.sheet, e.row, z.left);
      if (z.top === z.bottom && e.col >= z.left && e.col <= z.right)
        return e.context.cell(v.sheet, z.top, e.col);
    }
    return err('#VALUE!', 'A range where one value is expected.');
  }
  if (isMatrix(v)) return v.rows[0]?.[0] ?? null;
  if (isUnion(v)) return err('#VALUE!', 'A union of ranges where one value is expected.');
  return v;
}

/** A number result as a cell holds it: not finite is `#NUM!`. */
function finite(n: number): CellValue {
  return Number.isFinite(n) ? n : err('#NUM!', 'The result is not a finite number.');
}

function arithmetic(op: string, a: number, b: number): CellValue {
  switch (op) {
    case '+':
      return finite(a + b);
    case '-':
      return finite(a - b);
    case '*':
      return finite(a * b);
    case '/':
      return b === 0 ? err('#DIV/0!', 'Division by zero.') : finite(a / b);
    default:
      if (a === 0 && b <= 0) return err(b === 0 ? '#NUM!' : '#DIV/0!', '0 to that power.');
      return finite(a ** b);
  }
}

function bounds(e: Evaluation, sheet: string, from: RelPart, to: RelPart): Zone | CellError {
  const limits = e.context.limits(sheet);
  const row = (p: RelPart, end: number) =>
    p.row === undefined ? end : p.rowAbs ? p.row : p.row + e.row;
  const col = (p: RelPart, end: number) =>
    p.col === undefined ? end : p.colAbs ? p.col : p.col + e.col;
  const r0 = row(from, 0);
  const r1 = row(to, limits.rows - 1);
  const c0 = col(from, 0);
  const c1 = col(to, limits.cols - 1);
  if (
    Math.min(r0, r1) < 0 ||
    Math.min(c0, c1) < 0 ||
    Math.max(r0, r1) >= limits.rows ||
    Math.max(c0, c1) >= limits.cols
  )
    return err('#REF!', 'The reference reaches outside the sheet.');
  return {
    top: Math.min(r0, r1),
    bottom: Math.max(r0, r1),
    left: Math.min(c0, c1),
    right: Math.max(c0, c1),
  };
}

function sheetOf(e: Evaluation, name: string | undefined): string | CellError {
  if (name === undefined) return e.sheet;
  return e.context.sheetByName(name) ?? err('#REF!', `No sheet named '${name}'.`);
}

function reference(sheet: string, zone: Zone): Reference {
  return { kind: 'ref', sheet, zone };
}

/** The references a value holds, for the range and intersection operators. */
function references(v: Value): readonly Reference[] | undefined {
  if (isReference(v)) return [v];
  if (isUnion(v)) return v.refs;
  return undefined;
}

/** What a function is: looked up by its upper-case name. */
export type FunctionTable = (name: string) => FormulaFunction | undefined;

function argumentSpec(fn: FormulaFunction, i: number): FunctionArgument | undefined {
  if (i < fn.args.length) return fn.args[i];
  const last = fn.args[fn.args.length - 1];
  return last?.repeating ? last : undefined;
}

/**
 * Compile an AST at a cell. Literals become reads of the constants (their
 * index assigned in `shapeOf`'s walk order); references become offsets from
 * the evaluated cell; functions are looked up now, so a function switched off
 * means compiling again (the engine drops its shapes when the functions change).
 */
export function compile(
  ast: Ast,
  at: { row: number; col: number },
  functions: FunctionTable,
  /** Set to true when the formula must recalculate on every change (a volatile function, a computed range). */
  flags: { volatile: boolean } = { volatile: false },
): Compiled {
  // Constants are read from index 1: the engine keeps a cell's shape at index 0 of the same array.
  let k = 1;
  const walk = (a: Ast): Compiled => {
    switch (a.type) {
      case 'number':
      case 'string': {
        const i = k;
        k += 1;
        return (e) => e.constants[i] as number | string;
      }
      case 'bool': {
        const v = a.value;
        return () => v;
      }
      case 'error': {
        const code = a.code;
        return () => err(code);
      }
      case 'empty':
        return () => null;
      case 'name': {
        const name = a.name;
        return () => err('#NAME?', `Nothing is named '${name}'.`);
      }
      case 'cell': {
        const p = relative(a.ref, at);
        const name = a.sheet;
        return (e) => {
          const sheet = sheetOf(e, name);
          if (typeof sheet !== 'string') return sheet;
          const zone = bounds(e, sheet, p, p);
          return isCellError(zone) ? zone : reference(sheet, zone);
        };
      }
      case 'range': {
        const from = relative(a.from, at);
        const to = relative(a.to, at);
        const name = a.sheet;
        return (e) => {
          const sheet = sheetOf(e, name);
          if (typeof sheet !== 'string') return sheet;
          const zone = bounds(e, sheet, from, to);
          return isCellError(zone) ? zone : reference(sheet, zone);
        };
      }
      case 'call':
        if (a.name === ':') {
          // A range between computed references: its cells are known only when evaluated.
          flags.volatile = true;
          return rangeOperator(a.args.map(walk));
        }
        return call(a.name, a.args);
      case 'unary': {
        const arg = walk(a.arg);
        const negate = a.op === '-';
        return (e) => {
          const v = scalar(arg(e), e);
          if (isCellError(v)) return v;
          try {
            const n = toNumber(v);
            return negate ? -n : n;
          } catch (error) {
            return caught(error);
          }
        };
      }
      case 'percent': {
        const arg = walk(a.arg);
        return (e) => {
          const v = scalar(arg(e), e);
          if (isCellError(v)) return v;
          try {
            return toNumber(v) / 100;
          } catch (error) {
            return caught(error);
          }
        };
      }
      case 'binary':
        return binary(a.op, walk(a.left), walk(a.right));
      case 'union': {
        const items = a.items.map(walk);
        return (e) => {
          const refs: Reference[] = [];
          for (const item of items) {
            const v = item(e);
            const r = references(v);
            if (r === undefined)
              return isCellError(v) ? v : err('#VALUE!', 'A union joins references only.');
            refs.push(...r);
          }
          return { kind: 'union', refs };
        };
      }
      case 'array': {
        const rows = a.rows.map((r) => r.map(walk));
        return (e) => {
          const out: CellValue[][] = [];
          for (const r of rows) out.push(r.map((x) => scalar(x(e), e)));
          return { kind: 'matrix', rows: out };
        };
      }
    }
  };

  const rangeOperator = ([left, right]: Compiled[]): Compiled => {
    return (e) => {
      const l = left(e);
      const r = right(e);
      if (isCellError(l)) return l;
      if (isCellError(r)) return r;
      const all = [...(references(l) ?? []), ...(references(r) ?? [])];
      if (all.length === 0 || references(l) === undefined || references(r) === undefined)
        return err('#VALUE!', 'The range operator joins references only.');
      const sheet = all[0].sheet;
      if (all.some((x) => x.sheet !== sheet)) return err('#VALUE!', 'A range cannot span sheets.');
      return reference(sheet, {
        top: Math.min(...all.map((x) => x.zone.top)),
        left: Math.min(...all.map((x) => x.zone.left)),
        bottom: Math.max(...all.map((x) => x.zone.bottom)),
        right: Math.max(...all.map((x) => x.zone.right)),
      });
    };
  };

  const call = (name: string, args: readonly Ast[]): Compiled => {
    const fn = functions(name.toUpperCase());
    if (fn === undefined) {
      // The arguments still take their constants' indexes, so the walk order holds.
      args.forEach(walk);
      return () => err('#NAME?', `No function is named ${name}.`);
    }
    if (fn.volatile) flags.volatile = true;
    const compiled = args.map(walk);
    const required = fn.args.filter((x) => !x.optional).length;
    if (compiled.length < required || compiled.some((_, i) => argumentSpec(fn, i) === undefined)) {
      return () =>
        err('#VALUE!', `${fn.name} takes ${describeArity(fn)}; it was given ${compiled.length}.`);
    }
    const kinds = compiled.map((_, i) => argumentSpec(fn, i)!.type);
    return (e) => {
      const values: unknown[] = new Array(compiled.length);
      for (let i = 0; i < compiled.length; i += 1) {
        const node = compiled[i];
        switch (kinds[i]) {
          case 'lazy':
            values[i] = () => scalar(node(e), e);
            break;
          case 'any':
            values[i] = scalar(node(e), e);
            break;
          case 'range': {
            const v = node(e);
            if (isCellError(v)) return v;
            values[i] = v;
            break;
          }
          default: {
            const v = scalar(node(e), e);
            if (isCellError(v)) return v;
            values[i] = v;
          }
        }
      }
      if (fn.async) return e.awaited(fn.name, values, () => fn.compute(values, e.context));
      let result: Value | Promise<CellValue>;
      try {
        result = fn.compute(values, e.context);
      } catch (error) {
        return caught(error);
      }
      if (result instanceof Promise) {
        result.catch(() => undefined);
        throw new Error(`The function ${fn.name} returned a promise; declare it with async: true.`);
      }
      if (typeof result === 'number') return finite(result);
      if (result === undefined) throw new Error(`The function ${fn.name} returned nothing.`);
      return result;
    };
  };

  const binary = (op: string, left: Compiled, right: Compiled): Compiled => {
    if (op === ' ') {
      return (e) => {
        const l = left(e);
        const r = right(e);
        if (isCellError(l)) return l;
        if (isCellError(r)) return r;
        if (!isReference(l) || !isReference(r) || l.sheet !== r.sheet)
          return err('#VALUE!', 'The intersection operator takes two references on one sheet.');
        const zone = {
          top: Math.max(l.zone.top, r.zone.top),
          left: Math.max(l.zone.left, r.zone.left),
          bottom: Math.min(l.zone.bottom, r.zone.bottom),
          right: Math.min(l.zone.right, r.zone.right),
        };
        if (zone.top > zone.bottom || zone.left > zone.right)
          return err('#NULL!', 'The ranges do not intersect.');
        return reference(l.sheet, zone);
      };
    }
    return (e) => {
      const l = scalar(left(e), e);
      if (isCellError(l)) return l;
      const r = scalar(right(e), e);
      if (isCellError(r)) return r;
      try {
        switch (op) {
          case '&':
            return toText(l) + toText(r);
          case '=':
            return compare(l, r) === 0;
          case '<>':
            return compare(l, r) !== 0;
          case '<':
            return compare(l, r) < 0;
          case '<=':
            return compare(l, r) <= 0;
          case '>':
            return compare(l, r) > 0;
          case '>=':
            return compare(l, r) >= 0;
          default:
            return arithmetic(op, toNumber(l), toNumber(r));
        }
      } catch (error) {
        return caught(error);
      }
    };
  };

  return walk(ast);
}

function describeArity(fn: FormulaFunction): string {
  const required = fn.args.filter((x) => !x.optional).length;
  if (fn.args.some((x) => x.repeating))
    return `at least ${required} argument${required === 1 ? '' : 's'}`;
  return required === fn.args.length
    ? `${required} argument${required === 1 ? '' : 's'}`
    : `${required} to ${fn.args.length} arguments`;
}
